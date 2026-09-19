/**
 * @growth-os/db — database access foundations.
 *
 * The tenant-scoped unit of work is the single place that writes `app.*` settings. Nothing
 * else in the system may issue them (06-identity-and-access.md §4).
 */
export {
  asQueryable,
  insufficientHeadroom,
  type MaintenanceOptions,
  type MaintenanceResult,
  MINIMUM_HEADROOM_MONTHS,
  maintenanceSucceeded,
  type PartitionHeadroom,
  type Queryable,
  readPartitionHeadroom,
  runPartitionMaintenance,
  withMaintenanceConnection,
} from './partition-maintenance.js';
export { EXPECTED_SCHEMA_VERSION, KNOWN_MIGRATIONS } from './schema-version.js';
export {
  type OrganizationScopeOptions,
  type TenantContext,
  type TenantTransaction,
  withNewTenant,
  withOrganizationScope,
  withoutTenantContext,
  withTenant,
  workspaceIdsLiteral,
} from './tenant-context.js';
