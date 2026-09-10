/**
 * @growth-os/testing — the integration-test harness.
 *
 * Real PostgreSQL, real roles, real RLS. 11-testing-architecture.md §2 explains why a
 * mocked database is not an option here: a mock cannot fail to isolate a tenant, so it
 * cannot verify the control that the multi-tenant promise rests on.
 */
export {
  type ClusterHandle,
  readMigrations,
  resolvePgBin,
  type StartClusterOptions,
  startCluster,
} from './pg/cluster.js';
export {
  APP_ROLE,
  cloneDatabase,
  createAppPool,
  createTemplateDatabase,
  dropDatabase,
  MIGRATOR_ROLE,
  setTenantContext,
  TEMPLATE_DATABASE,
  type TenantContext,
  withRollback,
} from './pg/database.js';
export {
  acquireTestDatabase,
  migrationsDir,
  stopSharedCluster,
  type TestDatabase,
} from './pg/harness.js';
export { applyMigrations, currentSchemaVersion, type MigrationResult } from './pg/migrate.js';
