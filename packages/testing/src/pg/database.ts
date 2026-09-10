/**
 * Template-database strategy and per-test isolation.
 *
 * 11-testing-architecture.md §2: migrations run ONCE into a template, then each test file
 * clones it with CREATE DATABASE ... TEMPLATE, which takes milliseconds. Re-migrating per
 * file is what makes real-database suites slow enough that teams abandon them.
 */
import { randomUUID } from 'node:crypto';
import { Client, Pool, type PoolClient } from 'pg';
import type { ClusterHandle } from './cluster.js';
import { applyMigrations } from './migrate.js';

export const TEMPLATE_DATABASE = 'growth_os_template';

/** The RLS-enforced role. Tests connect as this, exactly as production does. */
export const APP_ROLE = 'growth_os_app';
export const MIGRATOR_ROLE = 'growth_os_migrator';

async function withSuperuser<T>(
  cluster: ClusterHandle,
  database: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: cluster.url(database) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates the template database and applies every migration to it once.
 *
 * Migrations run as the migrator role — the only place BYPASSRLS is used. If the harness
 * migrated as a superuser it would not exercise the privilege model we actually deploy.
 */
export async function createTemplateDatabase(
  cluster: ClusterHandle,
  migrationsDir: string,
): Promise<void> {
  await withSuperuser(cluster, 'postgres', async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DATABASE}`);
    await client.query(`CREATE DATABASE ${TEMPLATE_DATABASE}`);
  });

  // 0001 creates the roles, so the first run must connect as the superuser; afterwards the
  // migrator exists and owns subsequent work.
  await applyMigrations(cluster.url(TEMPLATE_DATABASE), migrationsDir);

  await withSuperuser(cluster, TEMPLATE_DATABASE, async (client) => {
    // Login capability is granted here rather than in the migration: production supplies
    // these roles' credentials through the secret manager, and a migration that sets a
    // password would put one in version control.
    await client.query(`ALTER ROLE ${APP_ROLE} LOGIN`);
    await client.query(`ALTER ROLE ${MIGRATOR_ROLE} LOGIN`);
    // Template databases must have no other sessions when cloned.
    await client.query(`ALTER DATABASE ${TEMPLATE_DATABASE} IS_TEMPLATE true`);
  });
}

/** Clones the template. Milliseconds, versus seconds to re-run migrations. */
export async function cloneDatabase(cluster: ClusterHandle): Promise<string> {
  const name = `gos_test_${randomUUID().replace(/-/g, '')}`;
  await withSuperuser(cluster, 'postgres', async (client) => {
    await client.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}`);
    await client.query(`GRANT ALL ON DATABASE ${name} TO ${MIGRATOR_ROLE}`);
    await client.query(`GRANT CONNECT ON DATABASE ${name} TO ${APP_ROLE}`);
  });
  return name;
}

export async function dropDatabase(cluster: ClusterHandle, name: string): Promise<void> {
  await withSuperuser(cluster, 'postgres', async (client) => {
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [name],
    );
    await client.query(`DROP DATABASE IF EXISTS ${name}`);
  });
}

export interface TenantContext {
  readonly organizationId: string;
  readonly userId?: string;
  readonly workspaceIds?: readonly string[];
}

/**
 * A pool connecting as the RLS-enforced application role.
 *
 * 11-testing-architecture.md §2: "Tests that bypass RLS would validate a system we do not
 * ship." Nothing in this harness offers a superuser connection to test code.
 */
export function createAppPool(cluster: ClusterHandle, database: string): Pool {
  return new Pool({ connectionString: cluster.url(database, APP_ROLE), max: 5 });
}

/**
 * Sets tenant context on an open transaction.
 *
 * SET LOCAL, never SET: transaction-scoped so it cannot leak onto another tenant's next
 * query through a recycled pooled connection. That distinction is what turns a pooling
 * optimisation into a data breach when it is got wrong (06-identity-and-access.md §4), so
 * the harness models it exactly as production does.
 */
export async function setTenantContext(client: PoolClient, context: TenantContext): Promise<void> {
  await client.query('SELECT set_config($1, $2, true)', [
    'app.organization_id',
    context.organizationId,
  ]);
  if (context.userId !== undefined) {
    await client.query('SELECT set_config($1, $2, true)', ['app.user_id', context.userId]);
  }
  if (context.workspaceIds !== undefined) {
    await client.query('SELECT set_config($1, $2, true)', [
      'app.workspace_ids',
      `{${context.workspaceIds.join(',')}}`,
    ]);
  }
}

/**
 * Runs `fn` inside a transaction that is ALWAYS rolled back.
 *
 * Per-test isolation without truncating tables between tests. Tests that must observe a
 * real commit (the outbox relay, advisory locks) take a dedicated cloned database instead.
 */
export async function withRollback<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  context?: TenantContext,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (context !== undefined) await setTenantContext(client, context);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {
      // The transaction may already be aborted; the connection is discarded either way.
    });
    client.release();
  }
}
