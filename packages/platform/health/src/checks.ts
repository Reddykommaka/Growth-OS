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
