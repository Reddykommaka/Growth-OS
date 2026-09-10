/**
 * Database wiring for the API process.
 *
 * The pool connects as growth_os_app, which is NOBYPASSRLS. There is no code path in an
 * application process that opens a connection as the migrator
 * (06-identity-and-access.md §4).
 */

import type { ServerEnv } from '@growth-os/config';
import { Pool } from 'pg';

export function createPool(env: ServerEnv): Pool {
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    // Fail fast rather than letting a request queue behind an exhausted pool.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
  });
}

/** Reads the newest applied migration, for the readiness check. */
export function schemaVersionSource(pool: Pool) {
  return {
    async currentVersion(): Promise<string | null> {
      const result = await pool.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1',
      );
      return result.rows[0]?.name ?? null;
    },
  };
}
