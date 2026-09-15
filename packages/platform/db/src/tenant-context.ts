/**
 * Tenant-scoped unit of work.
 *
 * Every transaction that touches tenant data opens with `SET LOCAL app.*`
 * (06-identity-and-access.md §4). This module is the ONLY place that writes those settings,
 * for two reasons:
 *
 *   1. `SET LOCAL` rather than `SET`. A session-level setting survives the transaction, and
 *      under a transaction-mode pooler the next tenant to receive that recycled connection
 *      inherits it. That is the exact failure mode that turns a pooling optimisation into a
 *      cross-tenant data breach. A structural test asserts no other code path issues a
 *      session-level SET for tenant context.
 *   2. The context is applied from a RESOLVED actor. Application code never chooses its own
 *      tenant: `withTenant` will not open a transaction without one.
 */
import { InternalError } from '@growth-os/errors';
import type { Pool, PoolClient } from 'pg';

/**
 * The resolved context handed to the database.
 *
 * Structurally compatible with the ActorContext resolved by @growth-os/authz, but declared
 * independently — platform/db must not depend on the authorization layer, and the database
 * needs only these three values.
 */
export interface TenantContext {
  readonly organizationId: string;
  readonly userId?: string;
  /** The resolved accessible-workspace set. Never derived here. */
  readonly workspaceIds: readonly string[];
  /**
   * How far this session may see across the tenant's workspaces.
   *
   * 'set' (the default, and the value for almost every session) restricts readable
   * workspaces to `workspaceIds`. 'all' is for an actor whose access genuinely spans the
   * organization, for whom the set IS every workspace — the two are then equivalent, and
   * saying 'all' avoids enumerating a list that only grows.
   *
   * Omitting it means 'set'. There is deliberately no way to get 'all' by accident.
   */
  readonly workspaceScope?: 'set' | 'all';
}

export interface TenantTransaction {
  /** Runs a query inside the tenant-scoped transaction. */
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
  readonly client: PoolClient;
  readonly context: TenantContext;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates every id before it reaches `set_config`.
 *
 * The settings are applied through `set_config($1, $2, true)` with bound parameters, so
 * this is not the injection defence — it is a correctness one. A malformed id would be
 * rejected by the `::uuid[]` cast inside the helper function at the first query rather than
 * at the point the context was built, turning a bad actor context into a confusing query
 * failure somewhere unrelated.
 */
function assertValidIds(context: TenantContext): void {
  if (!UUID.test(context.organizationId)) {
    throw new InternalError('Tenant context carries a malformed organization id.');
  }
  if (context.userId !== undefined && !UUID.test(context.userId)) {
    throw new InternalError('Tenant context carries a malformed user id.');
  }
  for (const id of context.workspaceIds) {
    if (!UUID.test(id)) {
      throw new InternalError('Tenant context carries a malformed workspace id.');
    }
  }
}

/** The `uuid[]` literal form PostgreSQL expects for app.workspace_ids. */
export function workspaceIdsLiteral(workspaceIds: readonly string[]): string {
  return `{${workspaceIds.join(',')}}`;
}

/**
 * Opens a transaction, applies tenant context, runs the body, and commits.
 *
 * Rolls back on any throw. The context is applied AFTER BEGIN and with the `is_local` flag
 * set, so it is discarded at COMMIT or ROLLBACK and cannot outlive the transaction on a
 * pooled connection.
 */
export async function withTenant<T>(
  pool: Pool,
  context: TenantContext,
  body: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  assertValidIds(context);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // `set_config(name, value, is_local => true)` is SET LOCAL with a bound parameter.
    await client.query('SELECT set_config($1, $2, true)', [
      'app.organization_id',
      context.organizationId,
    ]);
    await client.query('SELECT set_config($1, $2, true)', [
      'app.workspace_ids',
      workspaceIdsLiteral(context.workspaceIds),
    ]);
    // Always written, never left to the helper's default: an omitted scope is 'set', and
    // stating it explicitly means a stale value can never be inherited from anywhere.
    await client.query('SELECT set_config($1, $2, true)', [
      'app.workspace_scope',
      context.workspaceScope ?? 'set',
    ]);
    if (context.userId !== undefined) {
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', context.userId]);
    }

    const tx: TenantTransaction = {
      client,
      context,
      query: async (sql, params) => {
        const result = await client.query(sql, params as unknown[] | undefined);
        return { rows: result.rows as never[], rowCount: result.rowCount ?? 0 };
      },
    };

    const value = await body(tx);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Opens a transaction scoped to an organization but with NO workspace set.
 *
 * Exists for exactly one caller: the actor-context resolver, which has a genuine
 * chicken-and-egg problem. The accessible-workspace set is computed by reading
 * organization_members, teams, workspaces and role_assignments — all of which are
 * tenant-scoped and fail closed without `app.organization_id`. Resolution cannot run inside
 * `withTenant`, because the value `withTenant` needs is the one resolution produces.
 *
 * WHY THIS IS NOT A BYPASS. Setting `app.organization_id` is not an authorization grant. It
 * narrows what the connection can see to ONE organization; it does not establish that the
 * actor belongs to it. The membership row does that, and the resolver's first query looks
 * for it and returns nothing when it is absent. An actor passing an organization id they
 * have no membership in gets a context scoped to that organization and immediately finds no
 * membership — so nothing is read and no context is produced.
 *
 * The workspace set is deliberately left EMPTY here. Workspace-scoped tables (those
 * carrying workspace_id) therefore return nothing inside this transaction, which is correct:
 * resolution reads tenancy topology, never tenant content.
 *
 * Kept in this module rather than in the resolver so that every write of an `app.*` setting
 * remains in one reviewable file, which the architecture test enforces.
 */
export async function withOrganizationScope<T>(
  pool: Pool,
  organizationId: string,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertValidIds({ organizationId, workspaceIds: [] });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.organization_id', organizationId]);
    // Explicitly empty, not unset: an actor mid-resolution has no resolved set yet, and
    // leaving it unset would rely on the helper's COALESCE rather than saying so.
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_ids', '{}']);
    // Organization-wide READ of workspace topology, and the reason this function exists.
    // The resolver must see which team owns which workspace in order to compute the set at
    // all; a policy demanding the set would make the set underivable (migration 0007).
    //
    // This is the only place in the system that claims this scope without an actor having
    // earned it, which is why it is one function with one caller, both pinned by an
    // architecture test. It reads ids and team ids and returns a computed set — never rows.
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_scope', 'all']);
    const value = await body(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Opens a transaction for CREATING a tenant.
 *
 * Provisioning has a bootstrap problem of its own: it must write the `organizations` row and
 * everything that hangs off it — the default team, the owner's membership, the owner's role
 * assignment — under a tenant context that does not exist until the first of those
 * statements commits. The id is minted by the application (uuid v7, per 05 §1), so the
 * context can be set from the id it is about to insert.
 *
 * WHY THIS IS NOT A BYPASS. It writes into exactly one organization: the one being created.
 * RLS is fully in force — the connection is growth_os_app, NOBYPASSRLS — so every statement
 * inside is still checked against `organization_id = <the new org>`. An attempt to write a
 * row belonging to any OTHER organization fails here exactly as it would anywhere else.
 *
 * The workspace scope is 'all', because provisioning creates workspaces that are by
 * definition not yet in anybody's accessible set.
 *
 * It exists as a named primitive rather than as raw set_config in the provisioning module so
 * that every write of an `app.*` setting stays in this one reviewable file — which the
 * architecture test enforces, and which is how a second, less careful copy of this logic is
 * prevented from appearing.
 */
export async function withNewTenant<T>(
  pool: Pool,
  organizationId: string,
  actingUserId: string,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertValidIds({ organizationId, userId: actingUserId, workspaceIds: [] });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.organization_id', organizationId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.user_id', actingUserId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_ids', '{}']);
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_scope', 'all']);
    const value = await body(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Opens a transaction with NO tenant context, for the few operations that legitimately
 * precede one — looking a session up by token hash, redeeming an invitation, resolving
 * which organizations a user belongs to.
 *
 * Deliberately named to be conspicuous in review and in a grep. Every call site is a place
 * where RLS is not protecting the query, so the query itself must be narrow: keyed by a
 * high-entropy token or by a user id the caller has already authenticated.
 *
 * This is not a privilege escalation — the connection is still growth_os_app, still
 * NOBYPASSRLS. Tenant-scoped tables return zero rows here, because no context is set and
 * their policies fail closed. Only the untenanted identity tables are reachable.
 */
export async function withoutTenantContext<T>(
  pool: Pool,
  reason: string,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (reason.trim().length === 0) {
    throw new InternalError('An untenanted transaction must state its reason.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await body(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
