/**
 * Chain integrity, ordering, concurrency and transactional coupling.
 *
 * These are the properties the hash chain exists for, and each is asserted against a real
 * cluster because each depends on database behaviour: row locking under concurrent writers,
 * rollback semantics, and what an attacker with direct SQL access can and cannot do.
 */

import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from '@growth-os/testing';
import { Client, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { genesisHash } from './canonical.js';
import type { AuditEventInput } from './event.js';
import { createAuditReader } from './reader.js';
import { createAuditRecorder } from './recorder.js';
import { verifyChain } from './verify.js';

let db: TestDatabase;
let admin: Client;

const ORG = '01900000-0000-7000-8000-0000000c0001';
const USER = '01900000-0000-7000-8000-0000000c2001';
const _SUPPORT = '01900000-0000-7000-8000-0000000c2002';

async function inTenant<T>(
  body: (client: PoolClient) => Promise<T>,
  options: { commit?: boolean; organizationId?: string } = {},
): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', [
      'app.organization_id',
      options.organizationId ?? ORG,
    ]);
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_ids', '{}']);
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_scope', 'all']);
    const value = await body(client);
    await client.query(options.commit === false ? 'ROLLBACK' : 'COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function entry(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    organizationId: ORG,
    actor: { type: 'user', userId: USER },
    action: 'organization.member.role_changed',
    resourceType: 'member',
    resourceId: 'm-1',
    result: 'succeeded',
    ...overrides,
  };
}

const recordOne = async (input: AuditEventInput = entry()) =>
  await inTenant(async (c) => await createAuditRecorder(c).record(input));

const readChain = async () =>
  await inTenant(async (c) => await createAuditReader(c).chainSlice(ORG, 1, 500));

beforeAll(async () => {
  db = await acquireTestDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();
}, 180_000);

afterAll(async () => {
  await admin.end();
  await db.close();
  await stopSharedCluster();
});

beforeEach(async () => {
  await admin.query('DELETE FROM audit_events');
  await admin.query('DELETE FROM audit_chain_heads');
});

describe('chain continuity', () => {
  it('starts from the organization’s genesis and links every event to the last', async () => {
    for (let i = 0; i < 5; i++) await recordOne(entry({ resourceId: `m-${i}` }));

    const events = await readChain();
    expect(events).toHaveLength(5);
    expect(events[0]?.prevHash).toEqual(genesisHash(ORG));
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]?.prevHash).toEqual(events[i - 1]?.hash);
    }
    expect(verifyChain(ORG, events)).toMatchObject({ valid: true, checked: 5 });
  });

  it('verifies a slice from a known point, as a long chain must be checked', async () => {
    for (let i = 0; i < 6; i++) await recordOne();
    const all = await readChain();
    const anchor = all[2];
    if (anchor === undefined) throw new Error('setup');

    const slice = all.slice(3);
    expect(
      verifyChain(ORG, slice, { startingAfter: { sequence: anchor.sequence, hash: anchor.hash } }),
    ).toMatchObject({ valid: true });

    // The same slice checked as though it began the chain is correctly rejected.
    expect(verifyChain(ORG, slice).valid).toBe(false);
  });
});

describe('tamper detection', () => {
  /**
   * The application cannot UPDATE this table at all, so tampering means direct database
   * access — a compromised superuser, or a restore from a doctored dump. That is exactly the
   * threat the chain exists for, so the tests use the admin connection to do real damage.
   */
  it('detects an altered field', async () => {
    for (let i = 0; i < 3; i++) await recordOne();
    await admin.query(
      `UPDATE audit_events SET action = 'organization.member.nothing_happened'
        WHERE organization_id = $1 AND sequence = 2`,
      [ORG],
    );

    const result = verifyChain(ORG, await readChain());
    expect(result.valid).toBe(false);
    expect(result.breaks).toContainEqual(
      expect.objectContaining({ kind: 'hash_mismatch', sequence: 2 }),
    );
  });

  it('detects altered metadata, even a single character', async () => {
    await recordOne(entry({ metadata: { role: 'viewer' } }));
    await admin.query(
      `UPDATE audit_events SET metadata = '{"role":"owner"}'::jsonb WHERE organization_id = $1`,
      [ORG],
    );
    expect(verifyChain(ORG, await readChain()).valid).toBe(false);
  });

  /** Deleting the evidence leaves a hole the sequence makes obvious. */
  it('detects a deleted event as a gap', async () => {
    for (let i = 0; i < 4; i++) await recordOne();
    await admin.query('DELETE FROM audit_events WHERE organization_id = $1 AND sequence = 3', [
      ORG,
    ]);

    const result = verifyChain(ORG, await readChain());
    expect(result.valid).toBe(false);
    expect(result.breaks).toContainEqual(
      expect.objectContaining({ kind: 'sequence_gap', expected: 3, found: 4 }),
    );
  });

  /**
   * The sophisticated attempt: alter a row AND recompute its hash so the row is internally
   * consistent. It still fails, because the NEXT event committed to the old hash.
   */
  it('detects a re-hashed forgery through the following link', async () => {
    for (let i = 0; i < 3; i++) await recordOne();
    const before = await readChain();
    const target = before[1];
    if (target === undefined) throw new Error('setup');

    const { hashEvent } = await import('./canonical.js');
    const forged = { ...target, action: 'organization.member.promoted' };
    const forgedHash = hashEvent(forged, target.prevHash);
    await admin.query(
      'UPDATE audit_events SET action = $2, hash = $3 WHERE organization_id = $1 AND sequence = 2',
      [ORG, forged.action, forgedHash],
    );

    const result = verifyChain(ORG, await readChain());
    expect(result.valid).toBe(false);
    // Row 2 now hashes correctly; row 3 is what exposes it.
    expect(result.breaks).toContainEqual(
      expect.objectContaining({ kind: 'broken_link', sequence: 3 }),
    );
  });

  it('detects a chain restarted under a different genesis', async () => {
    await recordOne();
    await admin.query('UPDATE audit_events SET prev_hash = $2 WHERE organization_id = $1', [
      ORG,
      genesisHash('01900000-0000-7000-8000-0000000c9999'),
    ]);
    const result = verifyChain(ORG, await readChain());
    expect(result.breaks.some((b) => b.kind === 'bad_genesis')).toBe(true);
  });

  it('reports every break, not just the first, so the damage can be sized', async () => {
    for (let i = 0; i < 5; i++) await recordOne();
    await admin.query(
      `UPDATE audit_events SET action = 'tampered' WHERE organization_id = $1 AND sequence IN (2, 4)`,
      [ORG],
    );
    const result = verifyChain(ORG, await readChain());
    const mismatches = result.breaks.filter((b) => b.kind === 'hash_mismatch');
    expect(mismatches).toHaveLength(2);
  });
});
