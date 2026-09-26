/**
 * Role posture — structural check 2 (11-testing-architecture.md §4).
 *
 * Separated from the RLS and isolation sweeps because it asks a different question. Those ask
 * "does the tenant predicate hold"; this asks "which roles are exempt from it, and what can
 * they reach". A role with BYPASSRLS is outside every policy in the schema, so the only thing
 * still bounding it is its grants — and that is a fact about roles, not about tables.
 */
import type { Client, Pool } from 'pg';

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
export async function checkRolePosture(
  client: Client | Pool,
  /**
   * The append-only tables to check. A parameter rather than a constant so a test can build
   * a FIXTURE proving the check works: with a fixed list, that fixture would have to be
   * named `audit_events`, and once the real table exists the two collide.
   */
  appendOnlyTables: readonly string[] = ['audit_events'],
  /**
   * The roles permitted to hold BYPASSRLS. A parameter so adding one is a visible change in
   * a reviewed list rather than a check that quietly stops complaining.
   */
  bypassRlsAllowed: readonly string[] = ['growth_os_migrator', 'growth_os_relay'],
): Promise<RolePostureFinding[]> {
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
    if (role.rolbypassrls && !bypassRlsAllowed.includes(role.rolname)) {
      findings.push({ role: role.rolname, problem: 'unexpected role has BYPASSRLS' });
    }
  }

  /*
   * A BYPASSRLS role that is not the migrator must still be minimal in every OTHER respect.
   * BYPASSRLS buys one specific thing — reading across tenants — and a role that also holds
   * CREATE on the schema, or can make roles, has stopped being a bounded exception and become
   * a second superuser.
   */
  for (const role of roles.rows) {
    if (!role.rolbypassrls || role.rolname === 'growth_os_migrator') continue;
    if (role.rolsuper) findings.push({ role: role.rolname, problem: 'is a superuser' });
    if (role.rolcreatedb) findings.push({ role: role.rolname, problem: 'can create databases' });
    if (role.rolcreaterole) findings.push({ role: role.rolname, problem: 'can create roles' });
    const schema = await client.query<{ has: boolean }>(
      `SELECT has_schema_privilege($1, 'public', 'CREATE') AS has`,
      [role.rolname],
    );
    if (schema.rows[0]?.has === true) {
      findings.push({ role: role.rolname, problem: 'has CREATE on schema public' });
    }
  }

  // Append-only tables must withhold UPDATE and DELETE from the application role
  // (05-data-architecture.md §9). Enforced by privileges, not by convention.
  for (const table of appendOnlyTables) {
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

/**
 * Every table a role holds ANY privilege on.
 *
 * Exists so a BYPASSRLS role's reach can be asserted to EQUAL a declared list rather than
 * merely to include it. BYPASSRLS removes the tenant predicate everywhere, so the only thing
 * still bounding such a role is its grants — and a grant added without updating the
 * declaration is exactly the change that would go unnoticed.
 */
export async function bypassRlsRoleReach(client: Client | Pool, role: string): Promise<string[]> {
  const result = await client.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND (
          has_table_privilege($1, c.oid, 'SELECT')
          OR has_table_privilege($1, c.oid, 'INSERT')
          OR has_table_privilege($1, c.oid, 'UPDATE')
          OR has_table_privilege($1, c.oid, 'DELETE')
        )
      ORDER BY c.relname`,
    [role],
  );
  return result.rows.map((r) => r.relname);
}
