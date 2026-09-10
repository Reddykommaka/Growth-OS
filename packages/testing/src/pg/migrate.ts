/**
 * Migration runner.
 *
 * Forward-only, checksummed, applied by the migrator role in a discrete step — never on
 * application boot (12-devops-architecture.md §4: boot-time migration means N replicas
 * racing the same DDL, and a bad migration takes the application down with it).
 */
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { readMigrations } from './cluster.js';

export interface MigrationResult {
  readonly applied: string[];
  readonly skipped: string[];
}

const checksum = (sql: string): string => createHash('sha256').update(sql, 'utf8').digest('hex');

/** The ledger cannot be consulted before it exists, so migration 0001 creates it. */
const LEDGER = 'schema_migrations';

export async function applyMigrations(
  connectionUrl: string,
  migrationsDir: string,
): Promise<MigrationResult> {
  const migrations = readMigrations(migrationsDir);
  if (migrations.length === 0) {
    throw new Error(`No migrations found in ${migrationsDir}.`);
  }

  const client = new Client({ connectionString: connectionUrl });
  await client.connect();

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    // Fail fast rather than queueing behind a lock held by something else
    // (05-data-architecture.md §11).
    await client.query("SET lock_timeout = '10s'");
    await client.query("SET statement_timeout = '300s'");

    const ledgerExists = await client.query<{ exists: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS exists',
      [LEDGER],
    );
    const recorded = new Map<string, string>();
    if (ledgerExists.rows[0]?.exists === true) {
      const rows = await client.query<{ name: string; checksum: string }>(
        `SELECT name, checksum FROM ${LEDGER}`,
      );
      for (const row of rows.rows) recorded.set(row.name, row.checksum);
    }

    for (const migration of migrations) {
      const sum = checksum(migration.sql);
      const previous = recorded.get(migration.name);

      if (previous !== undefined) {
        if (previous !== sum) {
          // An applied migration is immutable. A changed one means two environments have
          // silently diverged, which is far worse to discover later.
          throw new Error(
            `Migration ${migration.name} has already been applied but its content has ` +
              'changed. Applied migrations are immutable — correct a mistake with a new ' +
              'migration (05-data-architecture.md §11).',
          );
        }
        skipped.push(migration.name);
        continue;
      }

      const started = Date.now();
      // Each migration is one transaction: it applies completely or not at all.
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO ${LEDGER} (name, checksum, duration_ms) VALUES ($1, $2, $3)`,
          [migration.name, sum, Date.now() - started],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      applied.push(migration.name);
    }
  } finally {
    await client.end();
  }

  return { applied, skipped };
}

/** The latest applied migration, for the readiness check. */
export async function currentSchemaVersion(connectionUrl: string): Promise<string | null> {
  const client = new Client({ connectionString: connectionUrl });
  await client.connect();
  try {
    const result = await client.query<{ name: string }>(
      `SELECT name FROM ${LEDGER} ORDER BY name DESC LIMIT 1`,
    );
    return result.rows[0]?.name ?? null;
  } finally {
    await client.end();
  }
}
