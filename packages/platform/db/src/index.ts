/**
 * @growth-os/db — database access foundations.
 *
 * Phase 0 provides the generated schema-version constants that /readyz compares against.
 * The Drizzle client, tenant session and UnitOfWork land in Phase 1 alongside the first
 * schema; there is nothing to wrap until tables exist.
 */
export { EXPECTED_SCHEMA_VERSION, KNOWN_MIGRATIONS } from './schema-version.js';
