/**
 * The partition maintenance registry (migration 0014, ADR-0021).
 *
 * These assertions are about the thing that made the missing scheduler dangerous rather
 * than merely untidy: partitions of audit_events and usage_records are separate tables
 * that inherit the application's default privileges and none of the parent's policies, so
 * a maintenance job that created them the generic way would quietly manufacture an
 * unpoliced copy of the audit log every month.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from './harness.js';

let db: TestDatabase;
let migrator: Client;

/** The migrator role, which is the only one the maintenance job ever runs as. */
const asMigrator = (adminUrl: string): string =>
  adminUrl.replace(/^postgres:\/\/[^@]*@/, 'postgres://growth_os_migrator@');

beforeAll(async () => {
  db = await acquireTestDatabase();
  migrator = new Client({ connectionString: asMigrator(db.adminUrl) });
  await migrator.connect();
}, 120_000);

afterAll(async () => {
  await migrator?.end();
  await db?.close();
  await stopSharedCluster();
});

const registeredTables = async (): Promise<string[]> => {
  const r = await migrator.query<{ parent_table: string }>(
    'SELECT parent_table FROM partition_maintenance ORDER BY 1',
  );
  return r.rows.map((x) => x.parent_table);
};

describe('the registry', () => {
  it('covers every partitioned table in the schema', async () => {
    const r = await migrator.query<{ unregistered_partitioned_tables: string }>(
      'SELECT * FROM unregistered_partitioned_tables()',
    );
    // If this fails, a migration added a partitioned table and did not register it. The
    // consequence is not a lint nit: nothing will pre-create its partitions, and the table
    // begins rejecting inserts in the month its last pre-created partition ends.
    expect(r.rows.map((x) => x.unregistered_partitioned_tables)).toEqual([]);
  });

  it('notices a partitioned table that is not registered', async () => {
    await migrator.query(`
      CREATE TABLE unregistered_facts (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        occurred_at timestamptz NOT NULL,
        PRIMARY KEY (id, occurred_at)
      ) PARTITION BY RANGE (occurred_at)`);
    try {
      const r = await migrator.query<{ unregistered_partitioned_tables: string }>(
        'SELECT * FROM unregistered_partitioned_tables()',
      );
      expect(r.rows.map((x) => x.unregistered_partitioned_tables)).toEqual(['unregistered_facts']);
    } finally {
      await migrator.query('DROP TABLE unregistered_facts');
    }
  });

  it('refuses an ensure_function that is not a bare identifier', async () => {
    await expect(
      migrator.query(
        `INSERT INTO partition_maintenance
           (parent_table, ensure_function, retention_note)
         VALUES ('facts', 'ensure_month_partitions(''x''); DROP TABLE audit_events; --', 'n')`,
      ),
    ).rejects.toThrow(/partition_maintenance_ensure_function_is_bare_name/);
  });

  it('records the retention policy, including where it is undecided', async () => {
    const r = await migrator.query<{
      parent_table: string;
      retention_months: number | null;
      archive_before_drop: boolean;
    }>(
      'SELECT parent_table, retention_months, archive_before_drop FROM partition_maintenance ORDER BY 1',
    );
    expect(r.rows).toEqual([
      { parent_table: 'audit_events', retention_months: 24, archive_before_drop: true },
      // Undecided is recorded as NULL rather than as a plausible default: a default here
      // would age out billing evidence on a number nobody chose.
      { parent_table: 'usage_records', retention_months: null, archive_before_drop: true },
    ]);
  });
});

describe('ensure_registered_partitions', () => {
  it('creates partitions for every registered table', async () => {
    const r = await migrator.query<{ parent_table: string; partitions: string[] }>(
      'SELECT * FROM ensure_registered_partitions()',
    );
    expect(r.rows.map((x) => x.parent_table)).toEqual(await registeredTables());
    for (const row of r.rows) {
      // months_ahead = 3 means the current month plus three.
      expect(row.partitions).toHaveLength(4);
    }
  });

  it('is idempotent, which is what makes running it on every deploy safe', async () => {
    const before = await migrator.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_class WHERE relispartition`,
    );
    await migrator.query('SELECT * FROM ensure_registered_partitions()');
    await migrator.query('SELECT * FROM ensure_registered_partitions()');
    const after = await migrator.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_class WHERE relispartition`,
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('hardens what it creates, rather than calling ensure_month_partitions generically', async () => {
    // The whole reason the registry dispatches per table, and the reason this test DROPS a
    // partition first: the migrations already created and hardened the current window, so a
    // run that creates nothing proves nothing. The partition must be created BY the job.
    const dropped = ['audit_events_', 'usage_records_'];
    const future = await migrator.query<{ relname: string; parent: string }>(
      `SELECT c.relname, parent.relname AS parent
         FROM pg_class parent
         JOIN pg_inherits i ON i.inhparent = parent.oid
         JOIN pg_class c    ON c.oid = i.inhrelid
        WHERE parent.relname IN ('audit_events', 'usage_records') AND c.relispartition
        ORDER BY c.relname`,
    );
    const newest = dropped.map(
      (prefix) => future.rows.filter((r) => r.relname.startsWith(prefix)).at(-1)?.relname,
    );
    expect(newest.filter((n) => n !== undefined)).toHaveLength(2);
    for (const name of newest) await migrator.query(`DROP TABLE ${name}`);

    const created = await migrator.query<{ parent_table: string; partitions: string[] }>(
      'SELECT * FROM ensure_registered_partitions()',
    );
    expect(created.rows).toHaveLength(2);

    // Every partition the job just re-created must have row security forced and the
    // application's DML revoked. A generically-created one would have neither, and would be
    // a readable, writable, unpoliced copy of the audit log.
    for (const name of newest) {
      const posture = await migrator.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        policies: number;
      }>(
        `SELECT c.relrowsecurity, c.relforcerowsecurity,
                (SELECT count(*)::int FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
           FROM pg_class c WHERE c.relname = $1`,
        [name],
      );
      expect(posture.rows[0]?.relrowsecurity, `${name} row security`).toBe(true);
      expect(posture.rows[0]?.relforcerowsecurity, `${name} forced`).toBe(true);
      expect(posture.rows[0]?.policies, `${name} policy count`).toBe(1);

      for (const privilege of ['UPDATE', 'DELETE']) {
        const granted = await migrator.query<{ has: boolean }>(
          `SELECT has_table_privilege('growth_os_app', $1, $2) AS has`,
          [name, privilege],
        );
        expect(granted.rows[0]?.has, `${name} ${privilege}`).toBe(false);
      }
      // …and still writable in the ways it must be.
      const insertable = await migrator.query<{ has: boolean }>(
        `SELECT has_table_privilege('growth_os_app', $1, 'INSERT') AS has`,
        [name],
      );
      expect(insertable.rows[0]?.has, `${name} INSERT`).toBe(true);
    }
  });

  it('fails loudly when a registered table no longer exists', async () => {
    await migrator.query(
      `INSERT INTO partition_maintenance (parent_table, ensure_function, retention_note)
       VALUES ('gone_facts', 'ensure_audit_partitions', 'fixture')`,
    );
    try {
      await expect(migrator.query('SELECT * FROM ensure_registered_partitions()')).rejects.toThrow(
        /registers gone_facts, which does not exist/,
      );
    } finally {
      await migrator.query(`DELETE FROM partition_maintenance WHERE parent_table = 'gone_facts'`);
    }
  });
});

describe('partition_headroom', () => {
  it('reports the runway the readiness probe alerts on', async () => {
    await migrator.query('SELECT * FROM ensure_registered_partitions()');
    const r = await migrator.query<{ parent_table: string; months_ahead: number }>(
      'SELECT * FROM partition_headroom()',
    );
    expect(r.rows.map((x) => x.parent_table)).toEqual(await registeredTables());
    for (const row of r.rows) {
      expect(row.months_ahead, row.parent_table).toBe(3);
    }
  });

  it('counts down as partitions are consumed, and goes negative past the cliff', async () => {
    // Dropping the future partitions is the only honest way to simulate a maintenance job
    // that stopped running; the alternative is waiting three months.
    const future = await migrator.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class parent
         JOIN pg_inherits i ON i.inhparent = parent.oid
         JOIN pg_class c    ON c.oid = i.inhrelid
        WHERE parent.relname = 'usage_records' AND c.relispartition
        ORDER BY c.relname DESC`,
    );
    const names = future.rows.map((x) => x.relname);
    expect(names.length).toBe(4);

    const headroom = async (): Promise<number | undefined> => {
      const r = await migrator.query<{ months_ahead: number }>(
        `SELECT months_ahead FROM partition_headroom() WHERE parent_table = 'usage_records'`,
      );
      return r.rows[0]?.months_ahead;
    };

    for (const [index, name] of names.entries()) {
      await migrator.query(`DROP TABLE ${name}`);
      // Dropping the newest first: after one drop two months remain ahead, and after the
      // last the table has no partition at all and cannot be written to.
      expect(await headroom(), `after dropping ${name}`).toBe(2 - index);
    }
    expect(await headroom()).toBe(-1);
  });

  it('is readable by the application role, because the probe runs as the application', async () => {
    const app = new Client({ connectionString: db.url });
    await app.connect();
    try {
      const r = await app.query('SELECT * FROM partition_headroom()');
      expect(r.rows.length).toBeGreaterThan(0);
    } finally {
      await app.end();
    }
  });

  it('does not let the application role run the maintenance itself', async () => {
    const app = new Client({ connectionString: db.url });
    await app.connect();
    try {
      await expect(app.query('SELECT * FROM ensure_registered_partitions()')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await app.end();
    }
  });
});
