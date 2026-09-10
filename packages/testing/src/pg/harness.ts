/**
 * Suite-level harness: one cluster and one migrated template per run, one cloned database
 * per test file.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { type ClusterHandle, startCluster } from './cluster.js';
import { cloneDatabase, createAppPool, createTemplateDatabase, dropDatabase } from './database.js';

export interface TestDatabase {
  readonly name: string;
  readonly pool: Pool;
  readonly url: string;
  /** Superuser URL — for harness-level assertions about roles and privileges only. */
  readonly adminUrl: string;
  close(): Promise<void>;
}

let cluster: ClusterHandle | null = null;
let templateReady: Promise<void> | null = null;

/**
 * Locates db/migrations by walking up from the caller.
 *
 * Resolved rather than hard-coded relative: vitest runs with different working directories
 * depending on whether it is invoked per package, from turbo, or from the repository root,
 * and a fixed '../../..' silently breaks when a package moves one level.
 */
export function migrationsDir(): string {
  const override = process.env['GROWTH_OS_MIGRATIONS_DIR'];
  if (override !== undefined) return resolve(override);

  let dir = process.cwd();
  for (let depth = 0; depth < 10; depth++) {
    const candidate = join(dir, 'db', 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not locate db/migrations by walking up from ' +
      `${process.cwd()}. Set GROWTH_OS_MIGRATIONS_DIR to point at it.`,
  );
}

/**
 * Starts the cluster and builds the template once per process, even under concurrent
 * callers. Vitest runs test files in parallel workers; without memoising the promise, each
 * would race to create the same template database.
 */
async function ensureCluster(): Promise<ClusterHandle> {
  if (cluster === null) {
    cluster = await startCluster();
  }
  if (templateReady === null) {
    templateReady = createTemplateDatabase(cluster, migrationsDir());
  }
  await templateReady;
  return cluster;
}

/** Acquires an isolated, migrated database. Call in `beforeAll`. */
export async function acquireTestDatabase(): Promise<TestDatabase> {
  const handle = await ensureCluster();
  const name = await cloneDatabase(handle);
  const pool = createAppPool(handle, name);

  return {
    name,
    pool,
    url: handle.url(name, 'growth_os_app'),
    adminUrl: handle.url(name),
    close: async () => {
      await pool.end();
      await dropDatabase(handle, name);
    },
  };
}

/** Stops the shared cluster. Call from the suite's global teardown. */
export async function stopSharedCluster(): Promise<void> {
  cluster?.stop();
  cluster = null;
  templateReady = null;
}
