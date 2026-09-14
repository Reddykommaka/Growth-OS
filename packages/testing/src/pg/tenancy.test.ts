/**
 * Phase 1 tenancy schema, probed against a real cluster.
 *
 * The four structural checks run here against the ACTUAL schema rather than fixtures, so
 * from this point on every table added to the tenancy model is swept automatically.
 *
 * The two asymmetric policies get dedicated probes on top of that sweep, because the
 * generic probe provably cannot catch an asymmetric hole (structural.test.ts:246): only the
 * policy's author knows which value satisfies the broad predicate.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from './harness.js';
import {
  checkFailsClosedWithoutContext,
  checkRlsCompleteness,
  checkRolePosture,
  probeCrossTenantAccess,
  tenantScopedTables,
} from './structural.js';

const ORG_A = '01890a5d-ac96-774b-bcce-b302099a9001';
const ORG_B = '01890a5d-ac96-774b-bcce-b302099a9002';
const USER_A = '01890a5d-ac96-774b-bcce-b302099a9101';
const WS_A = '01890a5d-ac96-774b-bcce-b302099a9201';
const WS_B = '01890a5d-ac96-774b-bcce-b302099a9202';

let db: TestDatabase;
let admin: Client;

/** Seeds one row per org on a privileged connection that product code never receives. */
async function seed(): Promise<void> {
  await admin.query(
    `INSERT INTO organizations (id, slug, name, kind) VALUES
       ($1, 'org-a', 'Org A', 'agency'),
       ($2, 'org-b', 'Org B', 'agency')`,
    [ORG_A, ORG_B],
  );
  await admin.query(
    `INSERT INTO users (id, email, status) VALUES ($1, 'a@example.test', 'active')`,
    [USER_A],
  );
  await admin.query(
    `INSERT INTO workspaces (id, organization_id, slug, name) VALUES
       ($1, $2, 'client-one', 'Client One'),
       ($3, $4, 'client-two', 'Client Two')`,
    [WS_A, ORG_A, WS_B, ORG_B],
  );
}

beforeAll(async () => {
  db = await acquireTestDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();
  await seed();
}, 120_000);

afterAll(async () => {
  await admin.end();
  await db.close();
  await stopSharedCluster();
});

describe('the schema sweep discovers the Phase 1 tables', () => {
  it('includes the tenant root, whose tenant column is id rather than organization_id', async () => {
    const tables = await tenantScopedTables(db.pool);
    expect(tables).toContain('organizations');
  });

  it('includes every tenancy and authorization table', async () => {
    const tables = await tenantScopedTables(db.pool);
    for (const table of [
      'organizations',
      'teams',
      'workspaces',
      'organization_members',
      'team_members',
      'team_workspace_access',
      'roles',
      'role_permissions',
      'role_assignments',
      'resource_grants',
      'invitations',
      'api_keys',
    ]) {
      expect(tables).toContain(table);
    }
  });

  it('excludes the global identity tables, which have no tenant to scope to', async () => {
    const tables = await tenantScopedTables(db.pool);
    for (const table of ['users', 'sessions', 'user_identities', 'mfa_credentials']) {
      expect(tables).not.toContain(table);
    }
  });
});

describe('structural check 1 — every tenant table is isolated', () => {
  it('reports no findings across the real schema', async () => {
    expect(await checkRlsCompleteness(db.pool)).toEqual([]);
  });
});

describe('structural check 2 — role posture', () => {
  it('reports no findings', async () => {
    expect(await checkRolePosture(db.pool)).toEqual([]);
  });
});

describe('structural check 3 — cross-tenant probes over the real schema', () => {
  it('no tenancy table leaks in any direction', async () => {
    const tables = await tenantScopedTables(db.pool);
    const leaks: unknown[] = [];
    for (const table of tables) {
      const r = await probeCrossTenantAccess(db.pool, table, ORG_A, ORG_B);
      if (r.selectLeaked > 0 || r.updateLeaked > 0 || r.deleteLeaked > 0 || r.insertAccepted) {
        leaks.push(r);
      }
    }
    expect(leaks).toEqual([]);
  });

  /**
   * The insert leg only means something if the probe row actually reached the policy. If a
   * NOT NULL or CHECK constraint rejects it first, "insert refused" says nothing about
   * isolation — and a later policy change that opened a real hole would still look green.
   *
   * Measured: PostgreSQL evaluates the RLS WITH CHECK before column constraints, so every
   * one of these tables rejects with 42501 today. Asserting it keeps that true.
   */
  it('every insert probe was rejected BY THE POLICY, not by a column constraint', async () => {
    const tables = await tenantScopedTables(db.pool);
    const unreachable: Record<string, string> = {};
    for (const table of tables) {
      const r = await probeCrossTenantAccess(db.pool, table, ORG_A, ORG_B);
      if (r.insertUnreachable !== undefined) unreachable[table] = r.insertUnreachable;
    }
    expect(unreachable).toEqual({});
  });
});

describe('structural check 4 — missing context fails closed', () => {
  it('no table returns a row with no organization set', async () => {
    expect(await checkFailsClosedWithoutContext(db.pool)).toEqual([]);
  });
});

/**
 * `roles` USING is deliberately broader than its write rule: system roles (organization_id
 * NULL) must be readable by every tenant. That is the exact shape that becomes a hole when
 * WITH CHECK is omitted — PostgreSQL would reuse the broad USING as the write predicate and
 * a tenant could mint itself a system role visible to every other tenant.
 */
describe('roles — the asymmetric policy that the generic probe cannot cover', () => {
  async function asOrgA<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.organization_id', ORG_A]);
      return await fn(client as unknown as Client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  beforeAll(async () => {
    await admin.query(
      `INSERT INTO roles (id, organization_id, slug, name, scope, is_system) VALUES
         (gen_random_uuid(), NULL, 'owner', 'Owner', 'organization', true),
         (gen_random_uuid(), $1, 'custom-a', 'Custom A', 'workspace', false),
         (gen_random_uuid(), $2, 'custom-b', 'Custom B', 'workspace', false)`,
      [ORG_A, ORG_B],
    );
  });

  it('lets a tenant read system roles', async () => {
    const rows = await asOrgA((c) =>
      c.query(`SELECT slug FROM roles WHERE organization_id IS NULL`),
    );
    expect(rows.rowCount).toBeGreaterThan(0);
  });

  it('lets a tenant read its own custom role', async () => {
    const rows = await asOrgA((c) => c.query(`SELECT slug FROM roles WHERE slug = 'custom-a'`));
    expect(rows.rowCount).toBe(1);
  });

  it("hides another tenant's custom role", async () => {
    const rows = await asOrgA((c) => c.query(`SELECT slug FROM roles WHERE slug = 'custom-b'`));
    expect(rows.rowCount).toBe(0);
  });

  it('REFUSES to let a tenant mint a system role — the hole WITH CHECK closes', async () => {
    await expect(
      asOrgA((c) =>
        c.query(
          `INSERT INTO roles (id, organization_id, slug, name, scope, is_system)
             VALUES (gen_random_uuid(), NULL, 'smuggled', 'Smuggled', 'organization', true)`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('REFUSES to let a tenant write a role into another organization', async () => {
    await expect(
      asOrgA((c) =>
        c.query(
          `INSERT INTO roles (id, organization_id, slug, name, scope, is_system)
             VALUES (gen_random_uuid(), $1, 'smuggled', 'Smuggled', 'workspace', false)`,
          [ORG_B],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

/**
 * `workspaces` USING is deliberately NARROWER than its write rule — the safe direction.
 * Reads are restricted to the actor's resolved accessible set, which is what stops a
 * client_guest learning that the agency's other clients exist. Writes use the plain tenant
 * predicate, because a workspace must be creatable before it can be in anyone's set.
 */
describe('workspaces — reads restricted to the accessible-workspace set', () => {
  async function asOrgAWithWorkspaces<T>(
    workspaceIds: string[],
    fn: (c: Client) => Promise<T>,
  ): Promise<T> {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.organization_id', ORG_A]);
      await client.query('SELECT set_config($1, $2, true)', [
        'app.workspace_ids',
        `{${workspaceIds.join(',')}}`,
      ]);
      return await fn(client as unknown as Client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  it('returns a workspace that is in the set', async () => {
    const r = await asOrgAWithWorkspaces([WS_A], (c) =>
      c.query('SELECT slug FROM workspaces WHERE id = $1', [WS_A]),
    );
    expect(r.rowCount).toBe(1);
  });

  it('hides a workspace in the same organization that is NOT in the set', async () => {
    const other = '01890a5d-ac96-774b-bcce-b302099a9299';
    await admin.query(
      `INSERT INTO workspaces (id, organization_id, slug, name) VALUES ($1, $2, 'other', 'Other')`,
      [other, ORG_A],
    );
    const r = await asOrgAWithWorkspaces([WS_A], (c) =>
      c.query('SELECT slug FROM workspaces WHERE id = $1', [other]),
    );
    expect(r.rowCount).toBe(0);
  });

  it('returns nothing at all when the set is empty — fails closed', async () => {
    const r = await asOrgAWithWorkspaces([], (c) => c.query('SELECT slug FROM workspaces'));
    expect(r.rowCount).toBe(0);
  });

  it('still permits creating a workspace that is not yet in any set', async () => {
    const fresh = '01890a5d-ac96-774b-bcce-b302099a9301';
    await expect(
      asOrgAWithWorkspaces([], (c) =>
        c.query(
          `INSERT INTO workspaces (id, organization_id, slug, name)
             VALUES ($1, $2, 'fresh', 'Fresh')`,
          [fresh, ORG_A],
        ),
      ),
    ).resolves.toBeDefined();
  });

  it('REFUSES to create a workspace in another organization', async () => {
    await expect(
      asOrgAWithWorkspaces([], (c) =>
        c.query(
          `INSERT INTO workspaces (id, organization_id, slug, name)
             VALUES (gen_random_uuid(), $1, 'smuggled', 'Smuggled')`,
          [ORG_B],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
