/**
 * Role posture over the real schema — structural check 2 (11-testing-architecture.md §4).
 *
 * Split from the tenancy sweeps because it asks a different question. Those ask "does the tenant
 * predicate hold"; this asks "which roles are exempt from it, and what can they reach". A role with
 * BYPASSRLS sits outside every policy in the schema, so the only thing still bounding it is its
 * grants — and a grant added without updating the expected set is precisely the change that would
 * otherwise go unnoticed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from './harness.js';
import { bypassRlsRoleReach, checkRolePosture } from './roles.js';
import { unreadableTables } from './structural.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await acquireTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
  await stopSharedCluster();
});

describe('structural check 2 — role posture', () => {
  it('reports no findings', async () => {
    expect(await checkRolePosture(db.pool)).toEqual([]);
  });

  /**
   * BYPASSRLS removes the tenant predicate everywhere, so the ONLY thing still bounding the
   * relay is its grants. Asserting equality rather than inclusion is the point: a grant added
   * without updating this list is exactly the change that would otherwise go unnoticed, and it
   * would silently hand a long-lived background process read access to tenant data.
   */
  it('the relay role reaches exactly the queues it drains', async () => {
    // Three queues, and nothing else. The role is named after its first consumer but it is the
    // worker's queue-draining role: relaying the outbox, sending the outbound queue and scanning
    // uploaded files are the same duty in the same process, and a role per queue would add
    // credentials to rotate while bounding nothing further. What bounds it is this list — asserted
    // by EQUALITY, so a widened grant fails here rather than going unnoticed.
    expect(await bypassRlsRoleReach(db.pool, 'growth_os_relay')).toEqual([
      'files',
      'outbound_messages',
      'outbox_events',
    ]);
  });

  /**
   * `outbound_messages` is the one tenant table the application may write and never read: it
   * carries invitation tokens sealed for a worker. Asserted by equality — a table gaining SELECT
   * is a privilege widening, one losing it is a broken feature, and neither should be found by
   * accident.
   */
  it('exactly one tenant table is write-only for the application', async () => {
    expect(await unreadableTables(db.pool)).toEqual(['outbound_messages']);
  });

  it('flags a BYPASSRLS role that is not on the allowlist', async () => {
    // Proves the allowlist is doing work. Without this, widening it to add the relay could
    // have been widened to anything.
    const findings = await checkRolePosture(db.pool, ['audit_events'], ['growth_os_migrator']);
    expect(findings).toEqual([
      { role: 'growth_os_relay', problem: 'unexpected role has BYPASSRLS' },
    ]);
  });
});
