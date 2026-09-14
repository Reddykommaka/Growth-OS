// GENERATED FILE — do not edit by hand.
// Regenerate with: node tools/scripts/generate-schema-version.mjs
//
// The migration this build of the application expects to be applied. /readyz refuses
// traffic when the database is BEHIND this version (12-devops-architecture.md §5).

/** The newest migration this build knows about. */
export const EXPECTED_SCHEMA_VERSION = '0005_authorization.sql';

/** Every migration this build knows about, in application order. */
export const KNOWN_MIGRATIONS: readonly string[] = [
  '0001_extensions_and_roles.sql',
  '0002_partition_helpers.sql',
  '0003_identity.sql',
  '0004_organizations.sql',
  '0005_authorization.sql',
];
