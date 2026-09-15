/**
 * @growth-os/db — database access foundations.
 *
 * The tenant-scoped unit of work is the single place that writes `app.*` settings. Nothing
 * else in the system may issue them (06-identity-and-access.md §4).
 */
export { EXPECTED_SCHEMA_VERSION, KNOWN_MIGRATIONS } from './schema-version.js';
export {
  type TenantContext,
  type TenantTransaction,
  withNewTenant,
  withOrganizationScope,
  withoutTenantContext,
  withTenant,
  workspaceIdsLiteral,
} from './tenant-context.js';
