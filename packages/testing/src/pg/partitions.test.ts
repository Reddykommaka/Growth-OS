/**
 * Partition helpers (05-data-architecture.md §7).
 *
 * These run against a real cluster because the behaviour under test IS PostgreSQL's:
 * partition bound arithmetic, idempotency, and the fact that a partitioned table with no
 * partition covering now() rejects the insert outright.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from './harness.js';

let db: TestDatabase;
let admin: Client;

beforeAll(async () => {
  db = await acquireTestDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();
  await admin.query(`
    CREATE TABLE facts (
      id          uuid        NOT NULL DEFAULT gen_random_uuid(),
      occurred_at timestamptz NOT NULL,
      PRIMARY KEY (id, occurred_at)
    ) PARTITION BY RANGE (occurred_at);
  `);
}, 120_000);

afterAll(async () => {
  await admin?.end();
  await db?.close();
  await stopSharedCluster();
});

const partitionNames = async (): Promise<string[]> => {
  const r = await admin.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class parent
       JOIN pg_inherits i ON i.inhparent = parent.oid
       JOIN pg_class c    ON c.oid = i.inhrelid
      WHERE parent.relname = 'facts' ORDER BY c.relname`,
  );
  return r.rows.map((x) => x.relname);
};

describe('create_month_partition', () => {
  it('creates a partition named for its month', async () => {
    const r = await admin.query<{ create_month_partition: string }>(
      "SELECT create_month_partition('facts', '2026-03-15'::date)",
    );
    expect(r.rows[0]?.create_month_partition).toBe('facts_2026_03');
    expect(await partitionNames()).toContain('facts_2026_03');
  });

  it('is idempotent — a scheduled job may call it repeatedly', async () => {
    await admin.query("SELECT create_month_partition('facts', '2026-03-01'::date)");
    await admin.query("SELECT create_month_partition('facts', '2026-03-28'::date)");
    const names = await partitionNames();
    expect(names.filter((n) => n === 'facts_2026_03')).toHaveLength(1);
  });

  it('normalises any day in the month to the month boundary', async () => {
    await admin.query("SELECT create_month_partition('facts', '2026-04-30'::date)");
    const bound = await admin.query<{ bound: string }>(
      `SELECT pg_get_expr(relpartbound, oid) AS bound FROM pg_class WHERE relname = 'facts_2026_04'`,
    );
    expect(bound.rows[0]?.bound).toContain("'2026-04-01");
    expect(bound.rows[0]?.bound).toContain("'2026-05-01");
  });

  it('routes a row into the correct partition', async () => {
    await admin.query("INSERT INTO facts (occurred_at) VALUES ('2026-03-10T12:00:00Z')");
    const r = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM facts_2026_03');
    expect(r.rows[0]?.n).toBe(1);
  });

  it('rejects a row with no covering partition', async () => {
    // The reason ensure_month_partitions runs ahead of need: a missed maintenance job would
    // otherwise turn into failed writes and dropped analytics facts.
    await expect(
      admin.query("INSERT INTO facts (occurred_at) VALUES ('2030-01-01T00:00:00Z')"),
    ).rejects.toThrow(/no partition of relation/i);
  });
});

describe('ensure_month_partitions', () => {
  it('creates the current month plus the requested lookahead', async () => {
    const r = await admin.query<{ ensure_month_partitions: string }>(
      "SELECT ensure_month_partitions('facts', 3)",
    );
    expect(r.rows).toHaveLength(4); // current + 3
  });

  it('is idempotent across runs', async () => {
    const before = await partitionNames();
    await admin.query("SELECT ensure_month_partitions('facts', 3)");
    expect(await partitionNames()).toEqual(before);
  });

  it('rejects a negative lookahead rather than silently doing nothing', async () => {
    await expect(admin.query("SELECT ensure_month_partitions('facts', -1)")).rejects.toThrow(
      /must not be negative/,
    );
  });
});

describe('detach_partitions_before', () => {
  it('detaches only partitions entirely before the cutoff', async () => {
    await admin.query("SELECT create_month_partition('facts', '2025-01-01'::date)");
    await admin.query("SELECT create_month_partition('facts', '2025-02-01'::date)");

    const r = await admin.query<{ detach_partitions_before: string }>(
      "SELECT detach_partitions_before('facts', '2025-02-01T00:00:00Z'::timestamptz)",
    );
    expect(r.rows.map((x) => x.detach_partitions_before)).toEqual(['facts_2025_01']);
  });

  it('detaches rather than drops, so data survives until it is archived', async () => {
    // 05-data-architecture.md §10: cold partitions are exported to Parquet before removal.
    // A helper that dropped them would make unrecoverable data loss a one-line mistake.
    const still = await admin.query<{ present: boolean }>(
      "SELECT to_regclass('public.facts_2025_01') IS NOT NULL AS present",
    );
    expect(still.rows[0]?.present).toBe(true);

    const attached = await partitionNames();
    expect(attached).not.toContain('facts_2025_01');
  });
});

describe('privileges', () => {
  it('the application role cannot run partition maintenance', async () => {
    // Partition management is scheduled operational work, never something a request triggers.
    const r = await db.pool.query<{ has: boolean }>(
      "SELECT has_function_privilege('growth_os_app', 'ensure_month_partitions(text,integer)', 'EXECUTE') AS has",
    );
    expect(r.rows[0]?.has).toBe(false);
  });
});
