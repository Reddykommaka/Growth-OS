/**
 * Proves the four structural tenant-isolation checks actually detect violations.
 *
 * Phase 0 ships no tenant-scoped tables, so running these against the real schema would
 * pass vacuously — the "green but inert" failure again. Instead the suite builds fixture
 * tables (one correctly secured, three broken in specific ways) and asserts each check
 * catches exactly what it is meant to.
 *
 * Phase 1 then inherits a guarantee that is already proven to work, rather than an
 * untested one.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE } from './database.js';
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from './harness.js';
import {
  checkFailsClosedWithoutContext,
  checkRlsCompleteness,
  checkRolePosture,
  probeCrossTenantAccess,
  tenantScopedTables,
} from './structural.js';

const ORG_A = '01890a5d-ac96-774b-bcce-b302099a8001';
const ORG_B = '01890a5d-ac96-774b-bcce-b302099a8002';

let db: TestDatabase;
let admin: Client;

/** A correctly secured tenant table: ENABLE + FORCE + policy with USING and WITH CHECK. */
const SECURED = `
  CREATE TABLE secured_widgets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    label           text
  );
  ALTER TABLE secured_widgets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE secured_widgets FORCE  ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON secured_widgets
    USING      (organization_id = app_current_organization_id())
    WITH CHECK (organization_id = app_current_organization_id());
  GRANT SELECT, INSERT, UPDATE, DELETE ON secured_widgets TO ${APP_ROLE};
`;

/** RLS switched on but never FORCEd — the owner silently bypasses its own policy. */
const UNFORCED = `
  CREATE TABLE unforced_widgets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL
  );
  ALTER TABLE unforced_widgets ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON unforced_widgets
    USING      (organization_id = app_current_organization_id())
    WITH CHECK (organization_id = app_current_organization_id());
  GRANT SELECT, INSERT, UPDATE, DELETE ON unforced_widgets TO ${APP_ROLE};
`;

/**
 * The marketplace shape: USING is deliberately broader than the write rule (published rows
 * are readable cross-tenant), and WITH CHECK is omitted. PostgreSQL then reuses the broad
 * read predicate for writes, so a tenant can insert a row carrying ANOTHER organization's
 * id simply by marking it published. This is the real WITH CHECK hole — verified against a
 * live cluster in Phase 0 and documented in 06-identity-and-access.md §4.
 */
const NO_WITH_CHECK = `
  CREATE TABLE halfsecured_widgets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    status          text NOT NULL DEFAULT 'draft'
  );
  ALTER TABLE halfsecured_widgets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE halfsecured_widgets FORCE  ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON halfsecured_widgets
    USING (status = 'published' OR organization_id = app_current_organization_id());
  GRANT SELECT, INSERT, UPDATE, DELETE ON halfsecured_widgets TO ${APP_ROLE};
`;

/**
 * A SYMMETRIC policy with WITH CHECK omitted. Included as a control: PostgreSQL falls back
 * to USING for writes, so this table is NOT exploitable — which is why the architecture's
 * original justification for requiring WITH CHECK was wrong, and why the rule is now
 * justified as forcing the author to state the write rule deliberately.
 */
const SYMMETRIC_NO_WITH_CHECK = `
  CREATE TABLE symmetric_widgets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL
  );
  ALTER TABLE symmetric_widgets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE symmetric_widgets FORCE  ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON symmetric_widgets
    USING (organization_id = app_current_organization_id());
  GRANT SELECT, INSERT, UPDATE, DELETE ON symmetric_widgets TO ${APP_ROLE};
`;

/** No RLS at all — the table a developer forgot to secure. */
const UNSECURED = `
  CREATE TABLE unsecured_widgets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL
  );
  GRANT SELECT, INSERT, UPDATE, DELETE ON unsecured_widgets TO ${APP_ROLE};
`;

beforeAll(async () => {
  db = await acquireTestDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();
  for (const ddl of [SECURED, UNFORCED, NO_WITH_CHECK, SYMMETRIC_NO_WITH_CHECK, UNSECURED]) {
    await admin.query(ddl);
  }
  // Seed Org B rows on the privileged connection; the app role must never see them.
  for (const table of [
    'secured_widgets',
    'unforced_widgets',
    'halfsecured_widgets',
    'symmetric_widgets',
    'unsecured_widgets',
  ]) {
    await admin.query(`INSERT INTO ${table} (organization_id) VALUES ($1), ($1)`, [ORG_B]);
  }
}, 120_000);

afterAll(async () => {
  await admin?.end();
  await db?.close();
  await stopSharedCluster();
});

describe('check 1 — schema completeness', () => {
  it('discovers tenant-scoped tables from the catalogue, not a hand-written list', async () => {
    const tables = await tenantScopedTables(admin);
    expect(tables).toEqual(
      expect.arrayContaining([
        'halfsecured_widgets',
        'secured_widgets',
        'unforced_widgets',
        'unsecured_widgets',
      ]),
    );
  });

  it('reports nothing for a correctly secured table', async () => {
    const findings = await checkRlsCompleteness(admin);
    expect(findings.filter((f) => f.table === 'secured_widgets')).toEqual([]);
  });

  it('catches a table with no RLS at all', async () => {
    const findings = await checkRlsCompleteness(admin);
    const problems = findings.filter((f) => f.table === 'unsecured_widgets').map((f) => f.problem);
    expect(problems).toContain('rls-not-enabled');
    expect(problems).toContain('rls-not-forced');
    expect(problems).toContain('no-policy');
  });

  it('catches RLS enabled but not FORCEd', async () => {
    // Without FORCE the table owner bypasses its own policy.
    const findings = await checkRlsCompleteness(admin);
    const problems = findings.filter((f) => f.table === 'unforced_widgets').map((f) => f.problem);
    expect(problems).toEqual(['rls-not-forced']);
  });

  it('catches a policy with USING but no explicit WITH CHECK', async () => {
    const findings = await checkRlsCompleteness(admin);
    for (const table of ['halfsecured_widgets', 'symmetric_widgets']) {
      const problems = findings.filter((f) => f.table === table).map((f) => f.problem);
      expect(problems, table).toEqual(['policy-missing-with-check']);
    }
  });
});

describe('check 2 — role posture', () => {
  it('reports no problems for the deployed roles', async () => {
    expect(await checkRolePosture(admin)).toEqual([]);
  });

  it('catches the application role acquiring BYPASSRLS', async () => {
    // The single most consequential misconfiguration in the system: every isolation policy
    // becomes inert while every other test still passes.
    await admin.query(`ALTER ROLE ${APP_ROLE} BYPASSRLS`);
    try {
      const findings = await checkRolePosture(admin);
      expect(findings).toContainEqual({ role: APP_ROLE, problem: 'has BYPASSRLS' });
    } finally {
      await admin.query(`ALTER ROLE ${APP_ROLE} NOBYPASSRLS`);
    }
    expect(await checkRolePosture(admin)).toEqual([]);
  });

  it('catches an UPDATE grant on an append-only table', async () => {
    await admin.query(`
      CREATE TABLE audit_events (id uuid PRIMARY KEY, organization_id uuid NOT NULL);
      ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
      ALTER TABLE audit_events FORCE  ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON audit_events
        USING      (organization_id = app_current_organization_id())
        WITH CHECK (organization_id = app_current_organization_id());
      GRANT SELECT, INSERT, UPDATE ON audit_events TO ${APP_ROLE};
    `);
    try {
      const findings = await checkRolePosture(admin);
      expect(findings).toContainEqual({
        role: 'growth_os_app',
        problem: 'has UPDATE on append-only audit_events',
      });
    } finally {
      await admin.query('DROP TABLE audit_events');
    }
  });
});

describe('check 3 — cross-tenant probes', () => {
  it('a correctly secured table leaks nothing in any direction', async () => {
    const result = await probeCrossTenantAccess(db.pool, 'secured_widgets', ORG_A, ORG_B);
    expect(result).toEqual({
      table: 'secured_widgets',
      selectLeaked: 0,
      updateLeaked: 0,
      deleteLeaked: 0,
      insertAccepted: false,
    });
  });

  it('catches an unsecured table leaking reads, updates and deletes', async () => {
    const result = await probeCrossTenantAccess(db.pool, 'unsecured_widgets', ORG_A, ORG_B);
    expect(result.selectLeaked).toBeGreaterThan(0);
    expect(result.updateLeaked).toBeGreaterThan(0);
    expect(result.insertAccepted).toBe(true);
  });

  it('catches a broad-USING write hole that a read-only probe would miss', async () => {
    // The marketplace shape. Cross-tenant READS of Org B's draft rows are blocked, so a
    // select-only test would report this table as safe — but the broad USING is reused as
    // the write predicate, so an INSERT carrying Org B's id is accepted. This is precisely
    // why the probe writes as well as reads.
    // extraColumns supplies the value that satisfies the broad predicate. A generic probe
    // cannot infer it — only the policy's author knows that 'published' is the magic value,
    // which is why an asymmetric policy needs a hand-written probe alongside it.
    const result = await probeCrossTenantAccess(db.pool, 'halfsecured_widgets', ORG_A, ORG_B, {
      status: 'published',
    });
    expect(result.selectLeaked).toBe(0);
    expect(result.insertAccepted).toBe(true);
  });

  it('the generic probe alone does NOT catch the asymmetric hole', async () => {
    // Documents the limit honestly rather than implying coverage the probe does not have.
    // Without the magic value the inserted row fails the broad predicate too, so the probe
    // reports the table as safe. The static WITH CHECK requirement is the real defence here.
    const generic = await probeCrossTenantAccess(db.pool, 'halfsecured_widgets', ORG_A, ORG_B);
    expect(generic.insertAccepted).toBe(false);
  });

  it('a symmetric policy is safe even with WITH CHECK omitted', async () => {
    // Documents the PostgreSQL behaviour that disproved the architecture's original
    // justification: with no WITH CHECK, USING is reused for writes, so a symmetric policy
    // still blocks a cross-tenant INSERT (06-identity-and-access.md §4).
    const result = await probeCrossTenantAccess(db.pool, 'symmetric_widgets', ORG_A, ORG_B);
    expect(result.selectLeaked).toBe(0);
    expect(result.insertAccepted).toBe(false);
  });

  it('covers every tenant-scoped table without a hand-written list', async () => {
    const tables = await tenantScopedTables(db.pool);
    const results = await Promise.all(
      tables.map((t) => probeCrossTenantAccess(db.pool, t, ORG_A, ORG_B)),
    );
    // Coverage grows with the schema: a table added later is probed automatically.
    expect(results).toHaveLength(tables.length);
    expect(results.find((r) => r.table === 'secured_widgets')?.selectLeaked).toBe(0);
  });
});

describe('check 4 — missing context fails closed', () => {
  it('a secured table returns zero rows when no organization is set', async () => {
    const leaking = await checkFailsClosedWithoutContext(db.pool);
    expect(leaking).not.toContain('secured_widgets');
  });

  it('identifies the tables that do leak without context', async () => {
    const leaking = await checkFailsClosedWithoutContext(db.pool);
    expect(leaking).toContain('unsecured_widgets');
  });
});

/**
 * The probe's insert leg is only meaningful if the probe row reaches the policy.
 *
 * A table whose minimal row (id + tenant column) violates a NOT NULL constraint is rejected
 * before RLS is consulted. A probe that only asks "did the insert fail?" calls that a pass —
 * so a policy that genuinely permits a cross-tenant write stays green behind an unrelated
 * constraint. This fixture is that exact situation, deliberately built.
 */
describe('check 3 — an insert the policy never saw is reported, not counted as safe', () => {
  const PERMISSIVE_WITH_NOT_NULL = `
    CREATE TABLE unreachable_widgets (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      -- The probe never supplies this, so the row dies here rather than at the policy.
      required_label  text NOT NULL
    );
    ALTER TABLE unreachable_widgets ENABLE ROW LEVEL SECURITY;
    ALTER TABLE unreachable_widgets FORCE  ROW LEVEL SECURITY;
    -- Deliberately wide open for writes: if the probe reached this policy it would be
    -- ACCEPTED, and the table would be leaking.
    CREATE POLICY tenant_isolation ON unreachable_widgets
      USING      (organization_id = app_current_organization_id())
      WITH CHECK (true);
    GRANT SELECT, INSERT, UPDATE, DELETE ON unreachable_widgets TO ${APP_ROLE};
  `;

  beforeAll(async () => {
    await admin.query(PERMISSIVE_WITH_NOT_NULL);
  });

  it('flags the insert as unreachable rather than refused', async () => {
    const result = await probeCrossTenantAccess(db.pool, 'unreachable_widgets', ORG_A, ORG_B);
    expect(result.insertAccepted).toBe(false);
    // 23502 = not_null_violation. The policy was never consulted.
    expect(result.insertUnreachable).toMatch(/23502/);
  });

  it('and reports a real leak once the constraint is satisfied', async () => {
    const result = await probeCrossTenantAccess(db.pool, 'unreachable_widgets', ORG_A, ORG_B, {
      required_label: 'probe',
    });
    expect(result.insertUnreachable).toBeUndefined();
    // With the row now reaching the wide-open WITH CHECK, the hole is visible.
    expect(result.insertAccepted).toBe(true);
  });
});
