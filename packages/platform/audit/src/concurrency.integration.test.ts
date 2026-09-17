/**
 * Concurrency, transactional coupling, actor attribution and ordering.
 *
 * Split from the tamper-detection suite purely for length; these are the properties that
 * depend on how PostgreSQL behaves under simultaneous writers and rollback, rather than on
 * what the hash covers.
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
const SUPPORT = '01900000-0000-7000-8000-0000000c2002';

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

describe('concurrent writers', () => {
  /**
   * The failure a per-organization chain invites: two transactions read the same tip, both
   * chain from it, and the log forks into two events at the same position. `FOR UPDATE` on
   * the head row is what prevents it, and this is the test that would fail without it.
   */
  it('twenty concurrent writers produce one gapless, verifiable chain', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => recordOne(entry({ resourceId: `m-${i}` }))),
    );

    const events = await readChain();
    expect(events).toHaveLength(20);
    expect(events.map((e) => e.sequence)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(verifyChain(ORG, events)).toMatchObject({ valid: true });
  });

  it('the first event of an organization is not a race', async () => {
    // No head row exists yet; several writers arrive at once and must not collide on it.
    await Promise.all(Array.from({ length: 5 }, () => recordOne()));
    const events = await readChain();
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events[0]?.prevHash).toEqual(genesisHash(ORG));
  });

  it('writers in different organizations do not contend', async () => {
    const OTHER = '01900000-0000-7000-8000-0000000d0001';
    await Promise.all([
      recordOne(),
      inTenant(async (c) => await createAuditRecorder(c).record(entry({ organizationId: OTHER })), {
        organizationId: OTHER,
      }),
    ]);
    // Each chain starts at 1: the sequences are per organization, not global.
    const mine = await readChain();
    const theirs = await inTenant(
      async (c) => await createAuditReader(c).chainSlice(OTHER, 1, 10),
      { organizationId: OTHER },
    );
    expect(mine[0]?.sequence).toBe(1);
    expect(theirs[0]?.sequence).toBe(1);
    expect(theirs[0]?.prevHash).toEqual(genesisHash(OTHER));
  });
});

describe('transactional coupling', () => {
  /**
   * The rule from 05 §9: the audit row is written in the SAME transaction as the change. A
   * rolled-back transaction must leave neither — announcing an event for a change that never
   * committed is exactly the dual-write failure the outbox exists to avoid elsewhere.
   */
  it('a rolled-back transaction leaves no audit event and no chain movement', async () => {
    await recordOne();
    const before = await readChain();

    await inTenant(
      async (c) => {
        await createAuditRecorder(c).record(entry({ resourceId: 'never-happened' }));
        // The business mutation fails after the audit write — the realistic ordering.
      },
      { commit: false },
    );

    const after = await readChain();
    expect(after).toHaveLength(before.length);
    expect(after.some((e) => e.resourceId === 'never-happened')).toBe(false);

    // And the head did not advance, so the next real event is sequence 2 with no gap.
    const next = await recordOne(entry({ resourceId: 'did-happen' }));
    expect(next.sequence).toBe(2);
    expect(verifyChain(ORG, await readChain())).toMatchObject({ valid: true });
  });

  it('a failing audit write fails the whole transaction rather than being swallowed', async () => {
    await expect(
      inTenant(async (c) => {
        await c.query('CREATE TEMP TABLE business_change (id int)');
        await c.query('INSERT INTO business_change VALUES (1)');
        // An organization the session is not scoped to: the policy refuses the insert.
        await createAuditRecorder(c).record(
          entry({ organizationId: '01900000-0000-7000-8000-0000000e0001' }),
        );
      }),
    ).rejects.toThrow();

    expect(await readChain()).toHaveLength(0);
  });
});

describe('actor attribution', () => {
  it('records a user actor', async () => {
    const e = await recordOne();
    expect(e.actor).toEqual({ type: 'user', userId: USER });
  });

  it('records a machine actor with no user behind it', async () => {
    const e = await recordOne(
      entry({ actor: { type: 'api_key', apiKeyId: '01900000-0000-7000-8000-0000000c3001' } }),
    );
    expect(e.actor).toEqual({ type: 'api_key', apiKeyId: '01900000-0000-7000-8000-0000000c3001' });
    const stored = await admin.query<{ actor_user_id: string | null }>(
      'SELECT actor_user_id FROM audit_events WHERE id = $1',
      [e.id],
    );
    expect(stored.rows[0]?.actor_user_id).toBeNull();
  });

  /**
   * IMPERSONATION MUST NOT ERASE ACCOUNTABILITY (06 §2). The effective actor is the
   * impersonated user — that is whose access was used — and the original actor is the
   * support engineer. Both are kept: collapsing them either hides who really acted or
   * blames someone who was not there.
   */
  it('keeps BOTH the effective and the original actor for an impersonated action', async () => {
    const e = await recordOne(
      entry({ actor: { type: 'user', userId: USER, impersonatorUserId: SUPPORT } }),
    );
    expect(e.actor).toEqual({ type: 'user', userId: USER, impersonatorUserId: SUPPORT });

    const read = await inTenant(
      async (c) => await createAuditReader(c).list({ organizationId: ORG }),
    );
    expect(read.events[0]?.actor.impersonatorUserId).toBe(SUPPORT);
  });

  it('the impersonator is inside the hash, so it cannot be stripped undetected', async () => {
    const e = await recordOne(
      entry({ actor: { type: 'user', userId: USER, impersonatorUserId: SUPPORT } }),
    );
    await admin.query('UPDATE audit_events SET impersonator_user_id = NULL WHERE id = $1', [e.id]);
    expect(verifyChain(ORG, await readChain()).valid).toBe(false);
  });

  it('refuses an event whose actor type and ids disagree', async () => {
    await expect(
      inTenant(async (c) =>
        c.query(
          `INSERT INTO audit_events
             (id, organization_id, sequence, occurred_at, actor_type, action, resource_type,
              resource_id, result, prev_hash, hash)
           VALUES (gen_random_uuid(), $1, 99, now(), 'user', 'a', 'b', 'c', 'succeeded',
                   $2, $2)`,
          [ORG, genesisHash(ORG)],
        ),
      ),
    ).rejects.toThrow(/actor_identified/i);
  });
});

describe('ordering and pagination', () => {
  it('lists newest first and pages without repeating or skipping', async () => {
    for (let i = 1; i <= 12; i++) await recordOne(entry({ resourceId: `m-${i}` }));

    const first = await inTenant(
      async (c) => await createAuditReader(c).list({ organizationId: ORG, limit: 5 }),
    );
    expect(first.events.map((e) => e.sequence)).toEqual([12, 11, 10, 9, 8]);
    expect(first.nextCursor).toBe(8);

    const second = await inTenant(
      async (c) =>
        await createAuditReader(c).list({
          organizationId: ORG,
          limit: 5,
          before: first.nextCursor,
        }),
    );
    expect(second.events.map((e) => e.sequence)).toEqual([7, 6, 5, 4, 3]);

    const third = await inTenant(
      async (c) =>
        await createAuditReader(c).list({
          organizationId: ORG,
          limit: 5,
          before: second.nextCursor,
        }),
    );
    expect(third.events.map((e) => e.sequence)).toEqual([2, 1]);
    expect(third.nextCursor).toBeUndefined();
  });

  /**
   * Keyset, not offset. Under an offset, events arriving mid-pagination shift every later
   * page — which in an audit log reads as evidence going missing.
   */
  it('a page is stable even when new events arrive between pages', async () => {
    for (let i = 1; i <= 6; i++) await recordOne(entry({ resourceId: `m-${i}` }));
    const first = await inTenant(
      async (c) => await createAuditReader(c).list({ organizationId: ORG, limit: 3 }),
    );

    for (let i = 7; i <= 9; i++) await recordOne(entry({ resourceId: `m-${i}` }));

    const second = await inTenant(
      async (c) =>
        await createAuditReader(c).list({
          organizationId: ORG,
          limit: 3,
          before: first.nextCursor,
        }),
    );
    expect(second.events.map((e) => e.sequence)).toEqual([3, 2, 1]);
  });

  it('filters by action, actor and resource', async () => {
    await recordOne(entry({ action: 'identity.signin.failed', resourceId: 'u-1' }));
    await recordOne(entry({ action: 'organization.api_key.created', resourceId: 'k-1' }));

    const failures = await inTenant(
      async (c) =>
        await createAuditReader(c).list({
          organizationId: ORG,
          action: 'identity.signin.failed',
        }),
    );
    expect(failures.events).toHaveLength(1);
    expect(failures.events[0]?.resourceId).toBe('u-1');
  });
});
