/**
 * The outbox writer against a real schema.
 *
 * The properties under test are PostgreSQL's, not ours: that the INSERT is governed by RLS,
 * that a rolled-back transaction leaves no event, and that the application role cannot mark
 * its own event published. A fake client could not fail any of them.
 */
import {
  acquireTestDatabase,
  setTenantContext,
  stopSharedCluster,
  type TestDatabase,
} from '@growth-os/testing';
import { Client, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { atOneInstant, createOutboxPublisher, refusingPublisher } from './outbox.js';

let db: TestDatabase;
let admin: Client;

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const WS_1 = '33333333-3333-4333-8333-333333333333';
const WS_2 = '44444444-4444-4444-8444-444444444444';

beforeAll(async () => {
  db = await acquireTestDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();
}, 120_000);

afterAll(async () => {
  await admin?.end();
  await db?.close();
  await stopSharedCluster();
});

afterEach(async () => {
  await admin.query('DELETE FROM outbox_events');
});

/** Runs inside a committed tenant transaction, exactly as an application service does. */
async function inTenant<T>(
  organizationId: string,
  workspaceIds: readonly string[],
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await setTenantContext(client, { organizationId, workspaceIds });
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const rows = async (): Promise<
  { id: string; event_name: string; organization_id: string; payload: Record<string, unknown> }[]
> => {
  const r = await admin.query<{
    id: string;
    event_name: string;
    organization_id: string;
    payload: Record<string, unknown>;
  }>('SELECT id, event_name, organization_id, payload FROM outbox_events ORDER BY occurred_at, id');
  return r.rows;
};

describe('staging', () => {
  it('writes an event the tenant session can read back', async () => {
    const id = await inTenant(ORG_A, [WS_1], (c) =>
      createOutboxPublisher(c).stage({
        name: 'social.post.published',
        organizationId: ORG_A,
        workspaceId: WS_1,
        payload: { postId: 'p1' },
      }),
    );
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(id);
    expect(all[0]?.payload).toEqual({ postId: 'p1' });
  });

  it('stages a batch in one statement, preserving order', async () => {
    const at = new Date('2026-09-20T10:00:00Z');
    const ids = await inTenant(ORG_A, [WS_1], (c) =>
      createOutboxPublisher(c).stageAll(
        atOneInstant(
          ['a', 'b', 'c'].map((n) => ({
            name: `social.post.${n}_happened`,
            organizationId: ORG_A,
            payload: { n },
          })),
          at,
        ),
      ),
    );
    expect(ids).toHaveLength(3);
    const all = await rows();
    // All three share one instant, so `ORDER BY occurred_at, id` is the tiebreak that keeps
    // them stable — which is why the relay orders by both.
    expect(all.map((r) => r.payload['n']).sort()).toEqual(['a', 'b', 'c']);
  });

  it('stages nothing for an empty batch, and issues no statement', async () => {
    const ids = await inTenant(ORG_A, [WS_1], (c) => createOutboxPublisher(c).stageAll([]));
    expect(ids).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  /**
   * THE PROPERTY THE OUTBOX EXISTS FOR. The event and the state change share a transaction, so
   * a rollback must take the event with it. If this failed, the system would announce changes
   * that never happened — the exact dual-write bug ADR-0007 removes.
   */
  it('leaves no event behind when the transaction rolls back', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await setTenantContext(client, { organizationId: ORG_A, workspaceIds: [WS_1] });
      await createOutboxPublisher(client).stage({
        name: 'social.post.published',
        organizationId: ORG_A,
        payload: { postId: 'p1' },
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await rows()).toEqual([]);
  });

  it('refuses an invalid event before it reaches the database', async () => {
    await expect(
      inTenant(ORG_A, [WS_1], (c) =>
        createOutboxPublisher(c).stage({
          name: 'nope',
          organizationId: ORG_A,
          payload: {},
        }),
      ),
    ).rejects.toThrow(/wire contract/);
    expect(await rows()).toEqual([]);
  });

  it('refuses a payload carrying a secret before it reaches the database', async () => {
    await expect(
      inTenant(ORG_A, [WS_1], (c) =>
        createOutboxPublisher(c).stage({
          name: 'social.connection.authorized',
          organizationId: ORG_A,
          payload: { accessToken: 'ya29.secret' },
        }),
      ),
    ).rejects.toThrow(/forbidden/);
    expect(await rows()).toEqual([]);
  });
});

describe('tenant isolation', () => {
  it('refuses an event written into another organization', async () => {
    // The WITH CHECK is the second gate: the application layer already passes its own
    // organization, and RLS is what makes a bug there fail rather than cross a tenant.
    await expect(
      inTenant(ORG_A, [WS_1], (c) =>
        createOutboxPublisher(c).stage({
          name: 'social.post.published',
          organizationId: ORG_B,
          payload: {},
        }),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('hides another organization events', async () => {
    await inTenant(ORG_B, [WS_2], (c) =>
      createOutboxPublisher(c).stage({
        name: 'social.post.published',
        organizationId: ORG_B,
        payload: {},
      }),
    );
    const seen = await inTenant(ORG_A, [WS_1], (c) => c.query('SELECT id FROM outbox_events'));
    expect(seen.rows).toEqual([]);
  });

  it('hides an event for a workspace outside the accessible set', async () => {
    await inTenant(ORG_A, [WS_1, WS_2], (c) =>
      createOutboxPublisher(c).stage({
        name: 'social.post.published',
        organizationId: ORG_A,
        workspaceId: WS_2,
        payload: {},
      }),
    );
    // WS_2 is not in this session's set, so the row is invisible — the same enumeration
    // defence as workspaces and audit_events.
    const seen = await inTenant(ORG_A, [WS_1], (c) => c.query('SELECT id FROM outbox_events'));
    expect(seen.rows).toEqual([]);
  });

  it('shows an organization-wide event to any session in the organization', async () => {
    await inTenant(ORG_A, [WS_1], (c) =>
      createOutboxPublisher(c).stage({
        name: 'billing.subscription.renewed',
        organizationId: ORG_A,
        payload: {},
      }),
    );
    const seen = await inTenant(ORG_A, [WS_2], (c) => c.query('SELECT id FROM outbox_events'));
    expect(seen.rows).toHaveLength(1);
  });

  it('writes nothing with no tenant context at all', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        createOutboxPublisher(client).stage({
          name: 'social.post.published',
          organizationId: ORG_A,
          payload: {},
        }),
      ).rejects.toThrow(/row-level security|violates/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe("the relay's columns are not the tenant's", () => {
  it('refuses an application UPDATE, so an event cannot be marked published by its author', async () => {
    await inTenant(ORG_A, [WS_1], (c) =>
      createOutboxPublisher(c).stage({
        name: 'social.post.published',
        organizationId: ORG_A,
        payload: {},
      }),
    );
    // RLS would happily allow this row through the tenant predicate. What refuses it is the
    // absent privilege — a session that could mark its own event published would be able to
    // cancel its own side effects.
    await expect(
      inTenant(ORG_A, [WS_1], (c) => c.query('UPDATE outbox_events SET published_at = now()')),
    ).rejects.toThrow(/permission denied/);
  });

  it('refuses an application DELETE, so an unpublished event cannot be withdrawn', async () => {
    await inTenant(ORG_A, [WS_1], (c) =>
      createOutboxPublisher(c).stage({
        name: 'social.post.published',
        organizationId: ORG_A,
        payload: {},
      }),
    );
    await expect(
      inTenant(ORG_A, [WS_1], (c) => c.query('DELETE FROM outbox_events')),
    ).rejects.toThrow(/permission denied/);
    expect(await rows()).toHaveLength(1);
  });
});

describe('the refusing publisher', () => {
  it('throws rather than silently swallowing an event', () => {
    // A no-op publisher is the bug this prevents: a code path wired without one would look
    // like it emitted events and emit none.
    expect(() =>
      refusingPublisher.stage({ name: 'a.b.c', organizationId: ORG_A, payload: {} }),
    ).toThrow(/must not emit events/);
    expect(() => refusingPublisher.stageAll([])).toThrow(/must not emit events/);
  });
});
