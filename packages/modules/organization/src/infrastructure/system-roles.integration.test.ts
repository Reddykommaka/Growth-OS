/**
 * The seeded role rows and the code catalogue must agree.
 *
 * Migration 0006 seeds thirteen role ROWS; their permission sets live in code, in
 * @growth-os/authz SYSTEM_ROLES. That split is what lets a permission added to `editor`
 * reach organizations that already exist, without a data migration — but it only works
 * while the two halves describe the same thirteen roles.
 *
 * A role added in code with no row here would be unassignable (role_assignments carries a
 * foreign key to roles) and would fail at runtime, in provisioning, for whoever tried to
 * use it. A row here with no code definition would resolve to an EMPTY permission set —
 * an assignment that silently grants nothing, which is the worse of the two failures
 * because it looks like a working configuration.
 */
import { SYSTEM_ROLES } from '@growth-os/authz';
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from '@growth-os/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ROLE_IDS } from './actor-resolver.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await acquireTestDatabase();
}, 120_000);

afterAll(async () => {
  await db.close();
  await stopSharedCluster();
});

describe('seeded system roles match the code catalogue', () => {
  it('the database holds exactly the roles the catalogue defines', async () => {
    const rows = await db.pool.query<{ id: string; slug: string; scope: string }>(
      `SELECT id, slug, scope FROM roles WHERE organization_id IS NULL ORDER BY slug, scope`,
    );
    const seeded = rows.rows.map((r) => `${r.slug}:${r.scope}`).sort();
    const declared = SYSTEM_ROLES.map((r) => `${r.slug}:${r.scope}`).sort();
    expect(seeded).toEqual(declared);
  });

  it('every seeded row is marked is_system with no organization', async () => {
    const rows = await db.pool.query<{ bad: string }>(
      `SELECT slug AS bad FROM roles
        WHERE organization_id IS NULL AND is_system IS NOT TRUE`,
    );
    expect(rows.rows).toEqual([]);
  });

  /**
   * The id map in the resolver is what turns a role_assignments row into a permission set.
   * If it drifts from the seed, an assignment resolves to nothing — an actor with a role
   * and no permissions, which reads as a mysterious authorization bug rather than a typo.
   */
  it('the resolver id map matches the seeded ids exactly', async () => {
    const rows = await db.pool.query<{ id: string; slug: string; scope: string }>(
      `SELECT id, slug, scope FROM roles WHERE organization_id IS NULL`,
    );
    const fromDb = rows.rows.map((r) => `${r.id}|${r.slug}|${r.scope}`).sort();
    const fromCode = SYSTEM_ROLE_IDS.map(([id, slug, scope]) => `${id}|${slug}|${scope}`).sort();
    expect(fromDb).toEqual(fromCode);
  });

  it('every id in the resolver map resolves to a non-empty permission set', () => {
    for (const [, slug, scope] of SYSTEM_ROLE_IDS) {
      const role = SYSTEM_ROLES.find((r) => r.slug === slug && r.scope === scope);
      expect(role, `${slug}:${scope}`).toBeDefined();
      expect(role?.permissions.length, `${slug}:${scope}`).toBeGreaterThan(0);
    }
  });
});
