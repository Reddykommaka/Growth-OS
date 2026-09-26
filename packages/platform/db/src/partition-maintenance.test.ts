/**
 * The maintenance job against a real schema.
 *
 * The SQL functions have their own tests in @growth-os/testing; these assert the behaviour
 * the deploy step depends on — that an unregistered table short-circuits the run, that a
 * second run changes nothing, and that headroom is reported in the units the readiness
 * check interprets.
 */
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from '@growth-os/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  insufficientHeadroom,
  maintenanceSucceeded,
  type Queryable,
  readPartitionHeadroom,
  runPartitionMaintenance,
} from './partition-maintenance.js';

let db: TestDatabase;
let migrator: Client;

beforeAll(async () => {
  db = await acquireTestDatabase();
  migrator = new Client({ connectionString: db.migratorUrl });
  await migrator.connect();
}, 120_000);

afterAll(async () => {
  await migrator?.end();
  await db?.close();
  await stopSharedCluster();
});

const client = (): Queryable => migrator as unknown as Queryable;

describe('runPartitionMaintenance', () => {
  it('reports a healthy schema with three months of runway', async () => {
    const result = await runPartitionMaintenance(client());
    expect(result.unregistered).toEqual([]);
    expect(Object.keys(result.ensured).sort()).toEqual(['audit_events', 'usage_records']);
    expect(result.headroom.map((h) => h.monthsAhead)).toEqual([3, 3]);
    expect(maintenanceSucceeded(result)).toBe(true);
  });

  it('creates nothing under --check', async () => {
    const before = await migrator.query<{ n: string }>(
      'SELECT count(*) AS n FROM pg_class WHERE relispartition',
    );
    const result = await runPartitionMaintenance(client(), { checkOnly: true });
    expect(result.ensured).toEqual({});
    const after = await migrator.query<{ n: string }>(
      'SELECT count(*) AS n FROM pg_class WHERE relispartition',
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('short-circuits on an unregistered partitioned table rather than half-succeeding', async () => {
    await migrator.query(`
      CREATE TABLE stray_facts (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        occurred_at timestamptz NOT NULL,
        PRIMARY KEY (id, occurred_at)
      ) PARTITION BY RANGE (occurred_at)`);
    try {
      const result = await runPartitionMaintenance(client());
      expect(result.unregistered).toEqual(['stray_facts']);
      // Nothing was ensured. A run that created partitions for the registered tables and
      // returned success would look healthy while stray_facts counted down to a cliff.
      expect(result.ensured).toEqual({});
      expect(maintenanceSucceeded(result)).toBe(false);
    } finally {
      await migrator.query('DROP TABLE stray_facts');
    }
  });

  it('detects a table that has fallen past the cliff', async () => {
    const partitions = await migrator.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class parent
         JOIN pg_inherits i ON i.inhparent = parent.oid
         JOIN pg_class c    ON c.oid = i.inhrelid
        WHERE parent.relname = 'usage_records' AND c.relispartition`,
    );
    for (const row of partitions.rows) {
      await migrator.query(`DROP TABLE ${row.relname}`);
    }
    try {
      const headroom = await readPartitionHeadroom(client());
      const usage = headroom.find((h) => h.parentTable === 'usage_records');
      expect(usage?.monthsAhead).toBe(-1);
      expect(insufficientHeadroom(headroom).map((h) => h.parentTable)).toEqual(['usage_records']);

      // And a real run repairs it, which is what makes running this on every deploy the
      // production answer rather than a monitor that only complains.
      const repaired = await runPartitionMaintenance(client());
      expect(maintenanceSucceeded(repaired)).toBe(true);
      expect(repaired.ensured['usage_records']).toHaveLength(4);
    } finally {
      await runPartitionMaintenance(client());
    }
  });
});
