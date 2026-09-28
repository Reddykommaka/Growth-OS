/**
 * Structural tenant-isolation checks.
 *
 * 11-testing-architecture.md §4 requires four checks that fail the build rather than warn.
 * They are generated from information_schema rather than hand-written per table, so
 * **coverage grows with the schema automatically** — a table added in Phase 3 is probed
 * without anyone remembering to add a test for it.
 *
 * This is the difference between a control and a checklist.
 */
import type { Client, Pool } from 'pg';

export const TENANT_COLUMN = 'organization_id';

/**
 * The tenant root. Its tenant column is `id`, not `organization_id`, so a sweep that
 * discovers tables by column name cannot see it — leaving the one table that DEFINES a
 * tenant as the only one exempt from the check that every tenant table is isolated.
 *
 * Naming it here rather than adding an `organization_id` column to `organizations` keeps
 * the schema honest (a self-referencing tenant column invites a row whose id and
 * organization_id disagree) at the cost of one special case, stated once.
 */
export const TENANT_ROOT_TABLE = 'organizations';

/** The column carrying the tenant for a given table. */
export function tenantColumnFor(table: string): string {
  return table === TENANT_ROOT_TABLE ? 'id' : TENANT_COLUMN;
}

export interface RlsFinding {
  readonly table: string;
  readonly problem:
    | 'rls-not-enabled'
    | 'rls-not-forced'
    | 'no-policy'
    | 'policy-missing-using'
    | 'policy-missing-with-check';
}

/** Tables carrying the tenant column, excluding partitions (they inherit their parent's RLS). */
export async function tenantScopedTables(client: Client | Pool): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    `SELECT c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND (a.attname = $1 OR c.relname = $2)
        AND NOT a.attisdropped
      ORDER BY c.relname`,
    [TENANT_COLUMN, TENANT_ROOT_TABLE],
  );
  return [...new Set(result.rows.map((r) => r.table_name))];
}

/**
 * Structural check 1 — schema completeness.
 *
 * Every table with an organization_id must have RLS ENABLED *and* FORCED and at least one
 * policy carrying both USING and WITH CHECK.
 *
 * FORCE matters because without it the table owner bypasses its own policies.
 *
 * WITH CHECK is required for a subtler reason than an earlier draft of the architecture
 * claimed (corrected in 06-identity-and-access.md §4): PostgreSQL falls back to the USING
 * expression as the write predicate when WITH CHECK is omitted, so a *symmetric* policy is
 * safe without it. The omission is only exploitable where USING is deliberately broader
 * than the write rule — the marketplace case. Requiring it everywhere forces the author to
 * state the write rule deliberately rather than inherit whatever the read rule happens to
 * be, and the tables where that inheritance is wrong are the costliest to get wrong.
 */
export async function checkRlsCompleteness(client: Client | Pool): Promise<RlsFinding[]> {
  const findings: RlsFinding[] = [];
  const tables = await tenantScopedTables(client);

  for (const table of tables) {
    const rel = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1`,
      [table],
    );
    const row = rel.rows[0];
    if (row === undefined) continue;
    if (!row.relrowsecurity) findings.push({ table, problem: 'rls-not-enabled' });
    if (!row.relforcerowsecurity) findings.push({ table, problem: 'rls-not-forced' });

    const policies = await client.query<{ qual: string | null; with_check: string | null }>(
      `SELECT qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
      [table],
    );
    if (policies.rows.length === 0) {
      findings.push({ table, problem: 'no-policy' });
      continue;
    }
    if (!policies.rows.some((p) => p.qual !== null)) {
      findings.push({ table, problem: 'policy-missing-using' });
    }
    if (!policies.rows.some((p) => p.with_check !== null)) {
      findings.push({ table, problem: 'policy-missing-with-check' });
    }
  }
  return findings;
}

export interface IsolationProbeResult {
  readonly table: string;
  readonly selectLeaked: number;
  readonly updateLeaked: number;
  readonly deleteLeaked: number;
  readonly insertAccepted: boolean;
  /**
   * Set when the INSERT probe was rejected by something OTHER than the RLS policy — a NOT
   * NULL, foreign key or CHECK violation from the deliberately minimal row the probe
   * builds. The row never reached the policy, so this table's write rule is UNPROVEN, not
   * proven safe.
   *
   * Without this, a loosened policy would still look green: the write would be permitted by
   * RLS and then rejected by a column constraint, and a probe that only asks "did the
   * insert fail?" would call that a pass. Pass `extraColumns` to satisfy the constraints
   * and turn the probe back into a real test.
   */
  readonly insertUnreachable?: string;
  /**
   * Set when UPDATE or DELETE was refused by a missing GRANT rather than filtered to zero
   * rows by the policy.
   *
   * This is a STRONGER outcome, not a weaker one: an append-only table withholds those
   * privileges entirely (05-data-architecture.md §9), so the statement never runs. Recorded
   * distinctly so the result stays honest — "nothing leaked because the policy filtered it"
   * and "nothing leaked because the statement was refused" are different facts.
   */
  readonly mutationsRefusedByPrivilege?: readonly string[];
  /**
   * Set when the SELECT itself was refused by a missing GRANT.
   *
   * Stronger again: `outbound_messages` carries invitation tokens sealed for a worker, and the
   * application role holds INSERT and no SELECT — so there is no statement for a leak to travel
   * through. Recorded distinctly for the same reason as the line above: a table quietly losing
   * the grant must not look identical to a policy doing its job.
   */
  readonly selectRefusedByPrivilege?: boolean;
}

/** PostgreSQL's insufficient_privilege — what an RLS WITH CHECK rejection raises. */
const RLS_VIOLATION = '42501';

/**
 * A missing GRANT, as opposed to a policy rejection.
 *
 * Both raise 42501, so the code alone cannot tell them apart; the message is what
 * distinguishes "permission denied for table x" from "new row violates row-level security
 * policy". Conflating them would report an append-only table's refusal as an RLS pass and
 * hide the fact that RLS was never consulted.
 */
function isPermissionDenied(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  return e?.code === RLS_VIOLATION && /permission denied/i.test(e?.message ?? '');
}

/**
 * Structural check 3 — cross-tenant probes.
 *
 * For each tenant-scoped table: with Org A's context active, attempt to read, update,
 * delete and insert Org B's rows. Every one must be a no-op.
 *
 * `appPool` connects as the RLS-enforced role. Seeding happens on a privileged connection
 * that is never handed to product code.
 *
 * **Known limit.** The generic probe inserts a minimal row: id and tenant column only. That
 * covers every symmetric policy, which is almost all of them. It CANNOT by itself trigger a
 * hole in an *asymmetric* policy — one whose USING is broader than its write rule — because
 * only the policy's author knows which column value satisfies the broad predicate (for
 * marketplace listings, `status = 'published'`). Pass `extraColumns` to drive that case, and
 * write a dedicated probe alongside any asymmetric policy. The static check
 * (`checkRlsCompleteness`) is the primary defence there: it requires an explicit WITH CHECK
 * on every policy regardless of shape.
 */
export async function probeCrossTenantAccess(
  appPool: Pool,
  table: string,
  organizationA: string,
  organizationB: string,
  extraColumns: Readonly<Record<string, string>> = {},
): Promise<IsolationProbeResult> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.organization_id', organizationA]);

    // `organizations` carries its tenant in `id`; every other table in `organization_id`.
    const tenantColumn = tenantColumnFor(table);

    // An append-only table has no UPDATE or DELETE grant at all, and `outbound_messages` has no
    // SELECT either, so the statement is refused before any row is considered. That must be
    // reported as the stronger guarantee it is, not crash the sweep — which is what happened the
    // first time such a table was added.
    const refusedByPrivilege: string[] = [];

    /*
     * A table the application cannot read AT ALL is the strongest possible answer to "does it
     * leak": there is no statement to leak through. Recorded rather than silently skipped,
     * because a table QUIETLY losing SELECT would otherwise look identical to one whose policy is
     * doing the work — and if the grant came back, nothing would say so.
     */
    let selectRefusedByPrivilege = false;
    let readRows = 0;
    try {
      const read = await client.query(`SELECT 1 FROM ${table} WHERE ${tenantColumn} = $1`, [
        organizationB,
      ]);
      readRows = read.rowCount ?? 0;
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      // The failed statement aborts the transaction; the probe continues in a clean one.
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.organization_id', organizationA]);
      selectRefusedByPrivilege = true;
    }
    const mutate = async (sql: string, label: string): Promise<number> => {
      const savepoint = `probe_${label}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const r = await client.query(sql, [organizationB]);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return r.rowCount ?? 0;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        if (isPermissionDenied(error)) {
          refusedByPrivilege.push(label);
          return 0;
        }
        throw error;
      }
    };

    const updated = await mutate(
      `UPDATE ${table} SET ${tenantColumn} = ${tenantColumn} WHERE ${tenantColumn} = $1`,
      'update',
    );
    const deleted = await mutate(`DELETE FROM ${table} WHERE ${tenantColumn} = $1`, 'delete');

    // Writes are probed as well as reads because a policy whose USING is broader than its
    // write rule (a published-listing predicate, say) blocks cross-tenant reads while still
    // accepting a cross-tenant INSERT. A select-only probe reports such a table as safe.
    let insertAccepted = false;
    const extraNames = Object.keys(extraColumns);
    // Not every tenant table has an `id`: a table keyed BY the organization (a per-tenant
    // singleton such as a chain head) has only the tenant column. Asking the catalogue
    // rather than assuming keeps the sweep generic, which is the whole point of it.
    const hasId = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'
       ) AS present`,
      [table],
    );
    const separateId = hasId.rows[0]?.present === true && tenantColumn !== 'id';
    const idColumns = separateId ? ['id', tenantColumn] : [tenantColumn];
    const idValues = separateId ? ['gen_random_uuid()', '$1'] : ['$1'];
    const columns = [...idColumns, ...extraNames].join(', ');
    const placeholders = [...idValues, ...extraNames.map((_, i) => `$${i + 2}`)];
    let insertUnreachable: string | undefined;
    try {
      await client.query(`INSERT INTO ${table} (${columns}) VALUES (${placeholders.join(', ')})`, [
        organizationB,
        ...extraNames.map((n) => extraColumns[n]),
      ]);
      insertAccepted = true;
    } catch (error) {
      insertAccepted = false;
      const code = (error as { code?: string }).code;
      // Anything other than an RLS rejection means the probe row died before the policy
      // was consulted. Reporting that as a pass is how a real hole stays green.
      if (code !== RLS_VIOLATION) {
        insertUnreachable = `${code ?? 'unknown'}: ${(error as Error).message}`;
      }
    }

    return {
      table,
      selectLeaked: readRows,
      ...(selectRefusedByPrivilege ? { selectRefusedByPrivilege: true } : {}),
      updateLeaked: updated,
      deleteLeaked: deleted,
      ...(refusedByPrivilege.length === 0
        ? {}
        : { mutationsRefusedByPrivilege: refusedByPrivilege }),
      insertAccepted,
      ...(insertUnreachable === undefined ? {} : { insertUnreachable }),
    };
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/**
 * Structural check 4 — missing context fails closed.
 *
 * With no app.organization_id set, current_setting(..., true) returns NULL, the policy
 * predicate is NULL (not true), and the table returns zero rows. Verified rather than
 * assumed, because "fails closed" is a claim about behaviour, not about intent.
 */
export async function checkFailsClosedWithoutContext(appPool: Pool): Promise<string[]> {
  const leaking: string[] = [];
  const tables = await tenantScopedTables(appPool);
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    // Deliberately set nothing.
    for (const table of tables) {
      const tenantColumn = tenantColumnFor(table);
      // Only rows that CARRY a tenant count. A few tables hold deliberately global rows
      // alongside tenant ones — `roles` and `role_permissions` keep the shared system roles
      // with organization_id NULL — and those are readable without context by design: they
      // describe the product, not any customer.
      //
      // Scoping the probe to non-NULL tenant values keeps this precise rather than adding a
      // table-level exemption, which would stop the check seeing a real leak on the same
      // table. For every table whose tenant column is NOT NULL, this is no weaker at all.
      const savepoint = `closed_${table.replace(/[^a-z0-9_]/gi, '')}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const result = await client.query(
          `SELECT 1 FROM ${table} WHERE ${tenantColumn} IS NOT NULL LIMIT 1`,
        );
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        if ((result.rowCount ?? 0) > 0) leaking.push(table);
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        // A table the application cannot SELECT cannot leak through one. That is stronger than
        // failing closed, not weaker — see `unreadableTables`, which asserts the set of such
        // tables so one losing or gaining the grant is never silent.
        if (!isPermissionDenied(error)) throw error;
      }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  return leaking;
}

/**
 * Tenant-scoped tables the application role cannot SELECT at all.
 *
 * `outbound_messages` is the one: it carries invitation tokens sealed for a worker, and the
 * application stages a message it may not read back (migration 0016). The set is returned rather
 * than assumed so a test can assert it by EQUALITY — a table quietly gaining SELECT is a
 * privilege widening, and a table quietly losing it is a broken feature, and neither should be
 * discoverable only by someone noticing.
 */
export async function unreadableTables(appPool: Pool): Promise<string[]> {
  const tables = await tenantScopedTables(appPool);
  const unreadable: string[] = [];
  for (const table of tables) {
    const granted = await appPool.query<{ has: boolean }>(
      `SELECT has_table_privilege(current_user, $1, 'SELECT') AS has`,
      [table],
    );
    if (granted.rows[0]?.has !== true) unreadable.push(table);
  }
  return unreadable;
}
