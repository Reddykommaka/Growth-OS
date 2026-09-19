/**
 * Partition maintenance — the production execution path for 05-data-architecture.md §7.
 *
 * Every unbounded-growth fact table is RANGE-partitioned by month, and a partitioned table
 * with no partition covering `now()` REJECTS the insert outright. For `audit_events` that
 * means every audited write in the product failing at once, which is the one outcome the
 * audit log exists to prevent. Pre-creation is therefore not housekeeping; it is the thing
 * standing between a missed maintenance window and an outage.
 *
 * The functions this calls live in migration 0014 and dispatch through each table's OWN
 * ensure function. That indirection is load-bearing rather than tidy: a partition is a
 * table in its own right, governed by its own policies and reached by migration 0001's
 * default privileges, so creating one the generic way would manufacture an unpoliced,
 * application-writable copy of the audit log every month.
 *
 * Runs as growth_os_migrator. ADR-0021 records why that puts it in the deploy pipeline
 * rather than in a BullMQ worker, and why retention is deliberately not done here.
 */
import { Client, type Pool } from 'pg';

/** Anything that can run a query — a Pool, a Client, or a PoolClient. */
export interface Queryable {
  query<R extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
}

export interface PartitionHeadroom {
  readonly parentTable: string;
  /**
   * Whole months of runway beyond the current month. `-1` means the table has no partition
   * covering now() and cannot be written to — distinct from `0`, which means it can be
   * written to this month and not next.
   */
  readonly monthsAhead: number;
}

export interface MaintenanceResult {
  /** Partitioned tables with no row in `partition_maintenance`. Non-empty is a failure. */
  readonly unregistered: readonly string[];
  /** Partitions that exist per table after the run; empty when `checkOnly`. */
  readonly ensured: Readonly<Record<string, readonly string[]>>;
  readonly headroom: readonly PartitionHeadroom[];
}

export interface MaintenanceOptions {
  /** Report only. Creates nothing — for a monitor, not for a deploy. */
  readonly checkOnly?: boolean;
}

/**
 * Months of runway below which headroom is reported as insufficient.
 *
 * Two, not zero. A table that has already run out cannot be written to, so alerting at zero
 * alerts during the outage rather than before it. Two months is one deploy cadence of
 * warning against the three-month runway the registry asks for.
 */
export const MINIMUM_HEADROOM_MONTHS = 2;

export async function readPartitionHeadroom(
  client: Queryable,
): Promise<readonly PartitionHeadroom[]> {
  const result = await client.query<{ parent_table: string; months_ahead: number }>(
    'SELECT parent_table, months_ahead FROM partition_headroom()',
  );
  return result.rows.map((row) => ({
    parentTable: row.parent_table,
    monthsAhead: row.months_ahead,
  }));
}

/**
 * Pre-creates partitions for every registered table and reports the resulting headroom.
 *
 * The unregistered check runs FIRST and short-circuits. Creating partitions for the tables
 * that are registered and returning success would report a healthy run while one table
 * quietly counted down to the cliff — the precise failure the registry was added to make
 * loud.
 */
export async function runPartitionMaintenance(
  client: Queryable,
  options: MaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const unregisteredRows = await client.query<{ unregistered_partitioned_tables: string }>(
    'SELECT * FROM unregistered_partitioned_tables()',
  );
  const unregistered = unregisteredRows.rows.map((r) => r.unregistered_partitioned_tables);
  if (unregistered.length > 0) {
    return { unregistered, ensured: {}, headroom: await readPartitionHeadroom(client) };
  }

  const ensured: Record<string, readonly string[]> = {};
  if (options.checkOnly !== true) {
    const created = await client.query<{ parent_table: string; partitions: string[] }>(
      'SELECT parent_table, partitions FROM ensure_registered_partitions()',
    );
    for (const row of created.rows) ensured[row.parent_table] = row.partitions;
  }

  return { unregistered, ensured, headroom: await readPartitionHeadroom(client) };
}

/** Tables whose runway has fallen below `MINIMUM_HEADROOM_MONTHS`. */
export const insufficientHeadroom = (
  headroom: readonly PartitionHeadroom[],
): readonly PartitionHeadroom[] => headroom.filter((h) => h.monthsAhead < MINIMUM_HEADROOM_MONTHS);

/** True when the run found nothing wrong. */
export const maintenanceSucceeded = (result: MaintenanceResult): boolean =>
  result.unregistered.length === 0 && insufficientHeadroom(result.headroom).length === 0;

/** Narrow the Pool type to the port, so callers need not import pg to call this. */
export const asQueryable = (pool: Pool): Queryable => pool as unknown as Queryable;

/**
 * Opens a single connection for the maintenance job and closes it afterwards.
 *
 * Exists so the job entrypoint does not import `pg` itself. A script reaching into another
 * package's node_modules for a driver works until the day the installer hoists differently,
 * and a deploy step that breaks on a dependency layout change is a bad deploy step.
 */
export async function withMaintenanceConnection<T>(
  connectionUrl: string,
  fn: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: connectionUrl });
  await client.connect();
  try {
    return await fn(client as unknown as Queryable);
  } finally {
    await client.end();
  }
}
