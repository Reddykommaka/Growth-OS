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
        AND a.attname = $1
        AND NOT a.attisdropped
      ORDER BY c.relname`,
    [TENANT_COLUMN],
  );
  return result.rows.map((r) => r.table_name);
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

export interface RolePostureFinding {
  readonly role: string;
  readonly problem: string;
}

/**
 * Structural check 2 — role posture.
 *
 * If growth_os_app ever acquires BYPASSRLS, every isolation policy in the system becomes
 * inert while every test still passes. This assertion is the tripwire.
 */
export async function checkRolePosture(client: Client | Pool): Promise<RolePostureFinding[]> {
  const findings: RolePostureFinding[] = [];

  const roles = await client.query<{
    rolname: string;
    rolbypassrls: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
  }>(
    `SELECT rolname, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole
       FROM pg_roles WHERE rolname LIKE 'growth\\_os\\_%' ORDER BY rolname`,
  );

  const app = roles.rows.find((r) => r.rolname === 'growth_os_app');
  if (app === undefined) {
    findings.push({ role: 'growth_os_app', problem: 'role does not exist' });
  } else {
    if (app.rolbypassrls) findings.push({ role: app.rolname, problem: 'has BYPASSRLS' });
    if (app.rolsuper) findings.push({ role: app.rolname, problem: 'is a superuser' });
    if (app.rolcreatedb) findings.push({ role: app.rolname, problem: 'can create databases' });
    if (app.rolcreaterole) findings.push({ role: app.rolname, problem: 'can create roles' });
  }

  for (const role of roles.rows) {
    if (role.rolbypassrls && role.rolname !== 'growth_os_migrator') {
      findings.push({ role: role.rolname, problem: 'unexpected role has BYPASSRLS' });
    }
  }

  // Append-only tables must withhold UPDATE and DELETE from the application role
  // (05-data-architecture.md §9). Enforced by privileges, not by convention.
  for (const table of ['audit_events']) {
    const exists = await client.query<{ present: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS present',
      [table],
    );
    if (exists.rows[0]?.present !== true) continue;
    for (const privilege of ['UPDATE', 'DELETE']) {
      const granted = await client.query<{ has: boolean }>(
        'SELECT has_table_privilege($1, $2, $3) AS has',
        ['growth_os_app', table, privilege],
      );
      if (granted.rows[0]?.has === true) {
        findings.push({
          role: 'growth_os_app',
          problem: `has ${privilege} on append-only ${table}`,
        });
      }
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

    const read = await client.query(`SELECT 1 FROM ${table} WHERE ${TENANT_COLUMN} = $1`, [
      organizationB,
    ]);
    const updated = await client.query(
      `UPDATE ${table} SET ${TENANT_COLUMN} = ${TENANT_COLUMN} WHERE ${TENANT_COLUMN} = $1`,
      [organizationB],
    );
    const deleted = await client.query(`DELETE FROM ${table} WHERE ${TENANT_COLUMN} = $1`, [
      organizationB,
    ]);

    // Writes are probed as well as reads because a policy whose USING is broader than its
    // write rule (a published-listing predicate, say) blocks cross-tenant reads while still
    // accepting a cross-tenant INSERT. A select-only probe reports such a table as safe.
    let insertAccepted = false;
    const extraNames = Object.keys(extraColumns);
    const columns = ['id', TENANT_COLUMN, ...extraNames].join(', ');
    const placeholders = ['gen_random_uuid()', '$1', ...extraNames.map((_, i) => `$${i + 2}`)];
    try {
      await client.query(`INSERT INTO ${table} (${columns}) VALUES (${placeholders.join(', ')})`, [
        organizationB,
        ...extraNames.map((n) => extraColumns[n]),
      ]);
      insertAccepted = true;
    } catch {
      insertAccepted = false;
    }

    return {
      table,
      selectLeaked: read.rowCount ?? 0,
      updateLeaked: updated.rowCount ?? 0,
      deleteLeaked: deleted.rowCount ?? 0,
      insertAccepted,
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
      const result = await client.query(`SELECT 1 FROM ${table} LIMIT 1`);
      if ((result.rowCount ?? 0) > 0) leaking.push(table);
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  return leaking;
}
