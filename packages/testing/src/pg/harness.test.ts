/**
 * Proves the harness itself works, and that it models production rather than a convenient
 * approximation of it.
 *
 * Exit criteria (18-phase-0-plan.md): #6 structural suites run against a real cluster,
 * #7 integration tests run with no Docker daemon.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, MIGRATOR_ROLE, withRollback } from './database.js';
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from './harness.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await acquireTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
  await stopSharedCluster();
});

describe('cluster and migrations', () => {
  it('runs against a real PostgreSQL server', async () => {
    const result = await db.pool.query<{ version: string }>('SELECT version()');
    expect(result.rows[0]?.version).toMatch(/PostgreSQL 1[6-9]/);
  });

  it('applied every migration and recorded it with a checksum', async () => {
    const result = await db.pool.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0]?.name).toBe('0001_extensions_and_roles.sql');
    expect(result.rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('created the required extensions', async () => {
    const result = await db.pool.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','citext','pg_trgm','vector') ORDER BY extname",
    );
    expect(result.rows.map((r) => r.extname)).toEqual(['citext', 'pg_trgm', 'pgcrypto', 'vector']);
  });
});

describe('role posture — structural test 2 (11-testing-architecture.md §4)', () => {
  it('the application role does NOT bypass RLS', async () => {
    // The single most important assertion in the harness. If this ever passes as true,
    // every tenant-isolation policy in the system is inert.
    const result = await db.pool.query<{ rolbypassrls: boolean }>(
      'SELECT rolbypassrls FROM pg_roles WHERE rolname = $1',
      [APP_ROLE],
    );
    expect(result.rows[0]?.rolbypassrls).toBe(false);
  });

  it('the application role is not a superuser and cannot create roles or databases', async () => {
    const result = await db.pool.query<{
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
    }>('SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    expect(result.rows[0]).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false });
  });

  it('only the migrator bypasses RLS among deployed roles', async () => {
    // A prefix scan rather than an equality check on two known names: this also catches a
    // NEW growth_os_* role being added later with BYPASSRLS.
    const result = await db.pool.query<{ rolname: string }>(
      'SELECT rolname FROM pg_roles WHERE rolbypassrls AND rolname LIKE $1 ORDER BY rolname',
      ['growth\\_os\\_%'],
    );
    expect(result.rows.map((r) => r.rolname)).toEqual([MIGRATOR_ROLE]);
  });

  it('the application role cannot create objects in the public schema', async () => {
    // Schema change is a migration, reviewed as an artefact — not something a request can do.
    await expect(db.pool.query('CREATE TABLE illegal_table (id int)')).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe('tenant context helpers fail closed', () => {
  it('return NULL when no context is set', async () => {
    // 06-identity-and-access.md §5: with no organization set, an RLS predicate compares
    // against NULL, which is false, so a query matches zero rows. Fails closed by design.
    const result = await db.pool.query<{ org: string | null; usr: string | null }>(
      'SELECT app_current_organization_id() AS org, app_current_user_id() AS usr',
    );
    expect(result.rows[0]?.org).toBeNull();
    expect(result.rows[0]?.usr).toBeNull();
  });

  it('return an empty array for workspaces when unset, never NULL', async () => {
    const result = await db.pool.query<{ ids: string[] }>(
      'SELECT app_current_workspace_ids() AS ids',
    );
    expect(result.rows[0]?.ids).toEqual([]);
  });

  it('read the transaction-scoped setting', async () => {
    const org = '01890a5d-ac96-774b-bcce-b302099a8057';
    const value = await withRollback(
      db.pool,
      async (client) => {
        const r = await client.query<{ org: string }>(
          'SELECT app_current_organization_id() AS org',
        );
        return r.rows[0]?.org;
      },
      { organizationId: org, workspaceIds: ['01890a5d-ac96-774b-bcce-b302099a8058'] },
    );
    expect(value).toBe(org);
  });

  it('does not leak tenant context to the next transaction on the same connection', async () => {
    // SET LOCAL, not SET. A session-scoped setting would survive on a pooled connection and
    // hand one tenant's context to the next request — the exact failure that turns a
    // pooling optimisation into a data breach (06-identity-and-access.md §4).
    await withRollback(db.pool, async () => undefined, {
      organizationId: '01890a5d-ac96-774b-bcce-b302099a8057',
    });
    const after = await db.pool.query<{ org: string | null }>(
      'SELECT app_current_organization_id() AS org',
    );
    expect(after.rows[0]?.org).toBeNull();
  });
});

describe('per-test isolation', () => {
  beforeAll(async () => {
    const admin = new Client({ connectionString: db.adminUrl });
    await admin.connect();
    await admin.query('CREATE TABLE harness_probe (id serial PRIMARY KEY, note text)');
    await admin.query(`GRANT SELECT, INSERT ON harness_probe TO ${APP_ROLE}`);
    await admin.query(`GRANT USAGE, SELECT ON SEQUENCE harness_probe_id_seq TO ${APP_ROLE}`);
    await admin.end();
  });

  it('rolls a write back so the next test sees a clean database', async () => {
    await withRollback(db.pool, async (client) => {
      await client.query("INSERT INTO harness_probe (note) VALUES ('written')");
      const inside = await client.query('SELECT count(*)::int AS n FROM harness_probe');
      expect(inside.rows[0]?.n).toBe(1);
    });

    const after = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM harness_probe',
    );
    expect(after.rows[0]?.n).toBe(0);
  });

  it('rolls back even when the body throws', async () => {
    await expect(
      withRollback(db.pool, async (client) => {
        await client.query("INSERT INTO harness_probe (note) VALUES ('doomed')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const after = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM harness_probe',
    );
    expect(after.rows[0]?.n).toBe(0);
  });
});

describe('migration ledger', () => {
  it('refuses to re-apply a migration whose content changed', async () => {
    const { applyMigrations } = await import('./migrate.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'gos-mig-'));
    // Same filename as the applied migration, different content: the merge accident this
    // check exists to catch.
    writeFileSync(join(dir, '0001_extensions_and_roles.sql'), 'SELECT 1;');

    await expect(applyMigrations(db.adminUrl, dir)).rejects.toThrow(/content has\s+changed/);
  });
});
