/**
 * The unit of work, against a real cluster.
 *
 * The claim this file exists to verify is the one the whole multi-tenant promise rests on:
 * tenant context is transaction-scoped, so a recycled pooled connection cannot carry one
 * tenant's context into another tenant's query. That is a claim about runtime behaviour
 * under connection reuse, and nothing short of a real pool and a real server tests it.
 */
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from '@growth-os/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withoutTenantContext, withTenant, workspaceIdsLiteral } from './tenant-context.js';

const ORG_A = '01890a5d-ac96-774b-bcce-b302099aa001';
const ORG_B = '01890a5d-ac96-774b-bcce-b302099aa002';
const USER_A = '01890a5d-ac96-774b-bcce-b302099aa101';
const WS_A1 = '01890a5d-ac96-774b-bcce-b302099aa201';
const WS_A2 = '01890a5d-ac96-774b-bcce-b302099aa202';
const WS_B1 = '01890a5d-ac96-774b-bcce-b302099aa203';

let db: TestDatabase;
let admin: Client;

beforeAll(async () => {
  db = await acquireTestDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();
  await admin.query(
    `INSERT INTO organizations (id, slug, name, kind) VALUES
       ($1, 'org-a', 'Org A', 'agency'), ($2, 'org-b', 'Org B', 'business')`,
    [ORG_A, ORG_B],
  );
  await admin.query(`INSERT INTO users (id, email, status) VALUES ($1, 'a@x.test', 'active')`, [
    USER_A,
  ]);
  await admin.query(
    `INSERT INTO workspaces (id, organization_id, slug, name) VALUES
       ($1, $2, 'a1', 'A One'), ($3, $2, 'a2', 'A Two'), ($4, $5, 'b1', 'B One')`,
    [WS_A1, ORG_A, WS_A2, WS_B1, ORG_B],
  );

  // `workspaces` is organization-scoped (05 §3 level 2), so it does not exercise
  // app.workspace_ids at all. A representative WORKSPACE-SCOPED table does, and no product
  // table carries workspace_id until Phase 3 — so the unit of work's handling of the set
  // would otherwise be untested here.
  await admin.query(`
    CREATE TABLE scoped_probe (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      workspace_id    uuid NOT NULL,
      label           text NOT NULL
    );
    CREATE INDEX scoped_probe_ws_idx ON scoped_probe (organization_id, workspace_id);
    ALTER TABLE scoped_probe ENABLE ROW LEVEL SECURITY;
    ALTER TABLE scoped_probe FORCE  ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON scoped_probe
      USING      (organization_id = app_current_organization_id()
                  AND workspace_id = ANY (app_current_workspace_ids()))
      WITH CHECK (organization_id = app_current_organization_id()
                  AND workspace_id = ANY (app_current_workspace_ids()));
    GRANT SELECT, INSERT, UPDATE, DELETE ON scoped_probe TO growth_os_app;
  `);
  await admin.query(
    `INSERT INTO scoped_probe (organization_id, workspace_id, label) VALUES
       ($1, $2, 'a1-row'), ($1, $3, 'a2-row'), ($4, $5, 'b1-row')`,
    [ORG_A, WS_A1, WS_A2, ORG_B, WS_B1],
  );
}, 120_000);

afterAll(async () => {
  await admin.end();
  await db.close();
  await stopSharedCluster();
});

describe('withTenant applies the context the actor resolved', () => {
  it('sees its own organization', async () => {
    const rows = await withTenant(
      db.pool,
      { organizationId: ORG_A, userId: USER_A, workspaceIds: [WS_A1, WS_A2] },
      async (tx) => (await tx.query<{ slug: string }>('SELECT slug FROM organizations')).rows,
    );
    expect(rows.map((r) => r.slug)).toEqual(['org-a']);
  });

  it('cannot see another organization, whatever it asks for', async () => {
    const rows = await withTenant(
      db.pool,
      { organizationId: ORG_A, workspaceIds: [] },
      async (tx) => (await tx.query('SELECT slug FROM organizations WHERE id = $1', [ORG_B])).rows,
    );
    expect(rows).toEqual([]);
  });

  it('sees every workspace row in its organization — that table is level 2', async () => {
    const rows = await withTenant(
      db.pool,
      { organizationId: ORG_A, workspaceIds: [WS_A1] },
      async (tx) =>
        (await tx.query<{ slug: string }>('SELECT slug FROM workspaces ORDER BY slug')).rows,
    );
    expect(rows.map((r) => r.slug)).toEqual(['a1', 'a2']);
  });

  it('sees exactly the workspace-SCOPED rows in the resolved set', async () => {
    const rows = await withTenant(
      db.pool,
      { organizationId: ORG_A, workspaceIds: [WS_A1] },
      async (tx) => (await tx.query<{ label: string }>('SELECT label FROM scoped_probe')).rows,
    );
    expect(rows.map((r) => r.label)).toEqual(['a1-row']);
  });

  it('sees no workspace-scoped row with an empty set — fails closed', async () => {
    const rows = await withTenant(
      db.pool,
      { organizationId: ORG_A, workspaceIds: [] },
      async (tx) => (await tx.query('SELECT label FROM scoped_probe')).rows,
    );
    expect(rows).toEqual([]);
  });

  it("cannot reach another organization's row even with its workspace id in the set", async () => {
    const rows = await withTenant(
      db.pool,
      { organizationId: ORG_A, workspaceIds: [WS_B1] },
      async (tx) => (await tx.query('SELECT label FROM scoped_probe')).rows,
    );
    expect(rows).toEqual([]);
  });
});

/**
 * The pooler-safety property. `SET LOCAL` (here, set_config with is_local => true) is
 * discarded at COMMIT; plain `SET` would not be, and the next tenant handed that connection
 * would inherit it.
 */
describe('tenant context does not survive the transaction', () => {
  it('a later transaction on the same pool sees no organization context', async () => {
    await withTenant(db.pool, { organizationId: ORG_A, workspaceIds: [WS_A1] }, async (tx) => {
      const r = await tx.query<{ org: string | null }>(
        'SELECT app_current_organization_id()::text AS org',
      );
      expect(r.rows[0]?.org).toBe(ORG_A);
    });

    // Drain the pool down to one connection so the next checkout is very likely the same
    // physical connection that just carried Org A's context.
    const client = await db.pool.connect();
    try {
      const r = await client.query<{ org: string | null }>(
        'SELECT app_current_organization_id()::text AS org',
      );
      expect(r.rows[0]?.org).toBeNull();
    } finally {
      client.release();
    }
  });

  it('a second withTenant for a different organization is not contaminated by the first', async () => {
    await withTenant(db.pool, { organizationId: ORG_A, workspaceIds: [WS_A1] }, async (tx) => {
      await tx.query('SELECT 1');
    });
    const rows = await withTenant(
      db.pool,
      { organizationId: ORG_B, workspaceIds: [WS_B1] },
      async (tx) => (await tx.query<{ slug: string }>('SELECT slug FROM organizations')).rows,
    );
    expect(rows.map((r) => r.slug)).toEqual(['org-b']);
  });

  it('a rolled-back transaction leaves no context behind either', async () => {
    await expect(
      withTenant(db.pool, { organizationId: ORG_A, workspaceIds: [WS_A1] }, async () => {
        throw new Error('deliberate');
      }),
    ).rejects.toThrow('deliberate');

    const client = await db.pool.connect();
    try {
      const r = await client.query<{ org: string | null }>(
        'SELECT app_current_organization_id()::text AS org',
      );
      expect(r.rows[0]?.org).toBeNull();
    } finally {
      client.release();
    }
  });
});

describe('the unit of work refuses a context it cannot trust', () => {
  it('rejects a malformed organization id before opening a transaction', async () => {
    await expect(
      withTenant(db.pool, { organizationId: 'not-a-uuid', workspaceIds: [] }, async () => 1),
    ).rejects.toThrow(/malformed organization id/i);
  });

  it('rejects a malformed workspace id', async () => {
    await expect(
      withTenant(db.pool, { organizationId: ORG_A, workspaceIds: ['nope'] }, async () => 1),
    ).rejects.toThrow(/malformed workspace id/i);
  });

  it('rolls back the body on an error rather than committing a partial write', async () => {
    await expect(
      withTenant(db.pool, { organizationId: ORG_A, workspaceIds: [WS_A1] }, async (tx) => {
        await tx.query(
          `INSERT INTO teams (id, organization_id, slug, name)
             VALUES (gen_random_uuid(), $1, 'doomed', 'Doomed')`,
          [ORG_A],
        );
        throw new Error('fail after write');
      }),
    ).rejects.toThrow('fail after write');

    const check = await admin.query(`SELECT 1 FROM teams WHERE slug = 'doomed'`);
    expect(check.rowCount).toBe(0);
  });

  it('commits when the body succeeds', async () => {
    await withTenant(db.pool, { organizationId: ORG_A, workspaceIds: [WS_A1] }, async (tx) => {
      await tx.query(
        `INSERT INTO teams (id, organization_id, slug, name)
           VALUES (gen_random_uuid(), $1, 'kept', 'Kept')`,
        [ORG_A],
      );
    });
    const check = await admin.query(`SELECT 1 FROM teams WHERE slug = 'kept'`);
    expect(check.rowCount).toBe(1);
  });
});

/**
 * The untenanted path exists for operations that legitimately precede a tenant — a session
 * lookup by token hash. It must remain unable to reach tenant data, or it becomes a bypass.
 */
describe('withoutTenantContext reaches identity but never tenant data', () => {
  it('can read the untenanted users table', async () => {
    const rows = await withoutTenantContext(db.pool, 'session lookup by token hash', async (c) => {
      const r = await c.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [USER_A]);
      return r.rows;
    });
    expect(rows).toHaveLength(1);
  });

  it('still sees ZERO tenant rows — the policies fail closed with no context', async () => {
    const counts = await withoutTenantContext(db.pool, 'probe', async (c) => {
      const orgs = await c.query('SELECT 1 FROM organizations');
      const workspaces = await c.query('SELECT 1 FROM workspaces');
      const teams = await c.query('SELECT 1 FROM teams');
      return [orgs.rowCount, workspaces.rowCount, teams.rowCount];
    });
    expect(counts).toEqual([0, 0, 0]);
  });

  it('demands a stated reason, so every call site is conspicuous in review', async () => {
    await expect(withoutTenantContext(db.pool, '   ', async () => 1)).rejects.toThrow(
      /must state its reason/i,
    );
  });
});

describe('the workspace set literal', () => {
  it('formats as a uuid[]', () => {
    expect(workspaceIdsLiteral([WS_A1, WS_A2])).toBe(`{${WS_A1},${WS_A2}}`);
  });

  it('formats empty as {} rather than NULL', () => {
    expect(workspaceIdsLiteral([])).toBe('{}');
  });
});
