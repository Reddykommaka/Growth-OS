/**
 * The concrete checks. Each is independent so an app wires only what it actually uses —
 * apps/link has no Redis, and a check for a dependency it does not have would be a
 * permanent false negative.
 */
import type { HealthCheck } from './index.js';

export interface SqlQueryable {
  query(sql: string): Promise<{ rows: unknown[] }>;
}

/** Round-trips a trivial query. Connectivity, not correctness. */
export function databaseCheck(client: SqlQueryable): HealthCheck {
  return {
    name: 'database',
    critical: true,
    async run() {
      await client.query('SELECT 1');
      return { status: 'pass' };
    },
  };
}

export interface SchemaVersionSource {
  /** The newest migration applied to the database, or null when none are. */
  currentVersion(): Promise<string | null>;
}

/**
 * Compares the deployed schema against the version this build expects.
 *
 * The asymmetry is deliberate and is the whole point of the check:
 *
 *   database BEHIND the code  → FAIL. The code expects a migration that has not run; it
 *                               will query a column that does not exist.
 *   database AHEAD of the code → PASS. Expand/contract guarantees every migration is safe
 *                               against the previous application version
 *                               (05-data-architecture.md §11), and during a rolling deploy
 *                               this is the normal, expected state. Failing here would
 *                               take the old replicas out of service mid-deploy — turning
 *                               a routine deploy into an outage.
 */
export function schemaVersionCheck(
  source: SchemaVersionSource,
  expected: string,
  known: readonly string[],
): HealthCheck {
  return {
    name: 'schema-version',
    critical: true,
    async run() {
      const current = await source.currentVersion();
      if (current === null) {
        return { status: 'fail', detail: 'no migrations have been applied' };
      }
      if (current === expected) {
        return { status: 'pass', observedValue: current };
      }
      // Lexical ordering is valid because migrations are zero-padded and numbered.
      if (current > expected) {
        return {
          status: 'pass',
          observedValue: current,
          detail: `database is ahead of this build (expects ${expected}); expected during a rolling deploy`,
        };
      }
      return {
        status: 'fail',
        observedValue: current,
        detail:
          `database is at ${current} but this build expects ${expected}. ` +
          `Missing: ${known.slice(known.indexOf(current) + 1).join(', ')}. ` +
          'Run the migration job before routing traffic here.',
      };
    },
  };
}

export interface Pingable {
  ping(): Promise<string>;
}

/**
 * Redis is NOT critical: it is never a system of record (02-technology-stack.md §4), so
 * losing it costs throughput, not correctness. Removing every replica from the load
 * balancer because a cache is down would convert a degradation into an outage.
 */
export function redisCheck(client: Pingable): HealthCheck {
  return {
    name: 'redis',
    critical: false,
    async run() {
      const reply = await client.ping();
      return reply === 'PONG'
        ? { status: 'pass' }
        : { status: 'warn', detail: `unexpected reply: ${reply}` };
    },
  };
}

export interface PartitionHeadroomReading {
  readonly parentTable: string;
  /**
   * Whole months of runway beyond the current month. `-1` means no partition covers
   * `now()`: the table is already refusing writes.
   */
  readonly monthsAhead: number;
}

export interface PartitionHeadroomSource {
  headroom(): Promise<readonly PartitionHeadroomReading[]>;
}

/**
 * How much runway must remain before the check warns.
 *
 * Matches the maintenance job's own threshold. Two months, not zero: a table that has
 * already run out cannot be written to, so a check that only fires at zero fires during the
 * outage rather than before it.
 */
export const MINIMUM_PARTITION_HEADROOM_MONTHS = 2;

/**
 * Runway before a partitioned table stops accepting writes.
 *
 * This is the only warning available before a real cliff. Every unbounded-growth fact table
 * is RANGE-partitioned monthly (05-data-architecture.md §7) and a partitioned table with no
 * partition covering `now()` REJECTS the insert — so for `audit_events` the failure mode is
 * every audited write in the product failing at once, on the first of a month, with no
 * preceding symptom. The maintenance job pre-creates three months ahead on every deploy;
 * this check is what notices when that has stopped happening.
 *
 * NOT CRITICAL, deliberately, even when a table has already run out. Headroom is identical
 * on every replica, so a critical check would take the entire fleet out of the load balancer
 * simultaneously — converting "one table cannot be written to" into "nothing serves at all",
 * and removing the replicas that were still serving every unaffected request. The condition
 * needs an operator and a migrator credential, neither of which a readiness probe has.
 */
export function partitionHeadroomCheck(
  source: PartitionHeadroomSource,
  minimumMonths: number = MINIMUM_PARTITION_HEADROOM_MONTHS,
): HealthCheck {
  return {
    name: 'partition-headroom',
    critical: false,
    async run() {
      const readings = await source.headroom();
      if (readings.length === 0) {
        // An empty registry is not "healthy": it means nothing is being maintained, which
        // looks exactly like a passing check right up until the first table runs out.
        return { status: 'warn', detail: 'no partitioned tables are registered for maintenance' };
      }

      const exhausted = readings.filter((r) => r.monthsAhead < 0);
      const short = readings.filter((r) => r.monthsAhead >= 0 && r.monthsAhead < minimumMonths);
      const observed = readings
        .map((r) => `${r.parentTable}=${r.monthsAhead}`)
        .sort()
        .join(' ');

      if (exhausted.length > 0) {
        return {
          status: 'fail',
          observedValue: observed,
          detail:
            `${exhausted.map((r) => r.parentTable).join(', ')} has no partition covering now() ` +
            'and is refusing writes. Run the partition maintenance job.',
        };
      }
      if (short.length > 0) {
        return {
          status: 'warn',
          observedValue: observed,
          detail:
            `${short.map((r) => r.parentTable).join(', ')} below ${minimumMonths} months of ` +
            'headroom. The maintenance job has not run recently enough.',
        };
      }
      return { status: 'pass', observedValue: observed };
    },
  };
}
