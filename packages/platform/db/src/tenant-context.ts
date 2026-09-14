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
