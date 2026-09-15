/**
 * Per-suite database lifecycle for the identity integration tests.
 *
 * Extracted so the suites can be split by concern without either copy of the reset logic
 * drifting — a truncation list that falls behind the schema leaves rows between tests, and
 * the resulting failures look like logic bugs rather than fixture bugs.
 */
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from '@growth-os/testing';
import { buildIdentity, type IdentityHarness } from './harness.js';

export const TEST_PASSWORD = 'correct horse battery staple';
export const FIXED_NOW = new Date('2026-09-15T12:00:00.000Z');

export interface IdentityFixture {
  db: TestDatabase;
  h: IdentityHarness;
}

export async function openIdentityFixture(): Promise<IdentityFixture> {
  const db = await acquireTestDatabase();
  return { db, h: buildIdentity(db.pool) };
}

export async function closeIdentityFixture(fixture: IdentityFixture): Promise<void> {
  await fixture.db.close();
  await stopSharedCluster();
}

/** Children before parents, so the foreign keys never block the reset. */
const TABLES = [
  'sessions',
  'user_tokens',
  'mfa_recovery_codes',
  'mfa_credentials',
  'user_identities',
  'users',
];

export async function resetIdentityTables(fixture: IdentityFixture): Promise<void> {
  for (const table of TABLES) {
    await fixture.db.pool.query(`DELETE FROM ${table}`);
  }
  fixture.h.audit.clear();
  fixture.h.clock.set(FIXED_NOW);
}
