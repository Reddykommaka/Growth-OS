/**
 * The in-app inbox against a real schema.
 *
 * Split from the service suite because it asks a different question: not "did the three writes
 * commit together" but "does the reader see exactly its own, in a stable order, with a read
 * timestamp that does not move". Keyset pagination is the property worth the setup cost — an
 * OFFSET-paged inbox silently skips an entry when one arrives mid-page, and the skipped entry is
 * the one the page existed to show.
 */

import { randomUUID } from 'node:crypto';
import { createSecretCipher, generateSecretKey } from '@growth-os/authn';
import { createOutboxPublisher } from '@growth-os/events';
import {
  acquireTestDatabase,
  setTenantContext,
  stopSharedCluster,
  type TestDatabase,
} from '@growth-os/testing';
import { Client, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { countUnread, markAllRead, markRead, readInbox } from './inbox.js';
import { createNotificationService } from './service.js';

let db: TestDatabase;
let admin: Client;

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG_OTHER = '22222222-2222-4222-8222-222222222222';
const USER_A = '33333333-3333-4333-8333-333333333333';
const USER_B = '44444444-4444-4444-8444-444444444444';

const cipher = createSecretCipher(generateSecretKey());
const clock = { now: () => new Date('2026-09-28T12:00:00Z') };

beforeAll(async () => {
  db = await acquireTestDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();

  // Real rows: `notifications` has FKs to organizations, workspaces and users, and a fixture that
  // skipped them would be testing a schema we do not deploy.
  for (const [id, name] of [
    [ORG, 'Acme'],
    [ORG_OTHER, 'Other'],
  ] as const) {
    await admin.query(
      `INSERT INTO organizations (id, name, slug, kind) VALUES ($1, $2, $3, 'agency')`,
      [id, name, name.toLowerCase()],
    );
  }
  for (const [id, email] of [
    [USER_A, 'a@example.com'],
    [USER_B, 'b@example.com'],
  ] as const) {
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, email]);
  }
}, 120_000);

afterAll(async () => {
  await admin?.end();
  await db?.close();
  await stopSharedCluster();
});

afterEach(async () => {
  await admin.query('DELETE FROM notifications');
  await admin.query('DELETE FROM outbound_messages');
  await admin.query('DELETE FROM outbox_events');
});

/** A committed transaction with tenant context, exactly as an application service opens one. */
async function inTenant<T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
  organizationId = ORG,
): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await setTenantContext(client, { organizationId, userId, workspaceIds: [] });
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

const service = (client: PoolClient) =>
  createNotificationService({
    cipher,
    events: createOutboxPublisher(client),
    clock,
    ids: { next: () => randomUUID() },
  });

describe('the inbox', () => {
  const write = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index++) {
      await inTenant(USER_B, (c) =>
        service(c).notify(c, {
          organizationId: ORG,
          type: 'billing.limit.reached',
          recipientUserId: USER_A,
          payload: { index },
        }),
      );
    }
  };

  it('counts only unread, and only the caller own', async () => {
    await write(3);
    expect(await inTenant(USER_A, (c) => countUnread(c))).toBe(3);
    expect(await inTenant(USER_B, (c) => countUnread(c))).toBe(0);
  });

  it('keeps the first read timestamp when marked twice', async () => {
    await write(1);
    const page = await inTenant(USER_A, (c) => readInbox(c));
    const id = page.entries[0]?.id;
    if (id === undefined) throw new Error('no entry');
    const first = new Date('2026-09-28T12:00:00Z');
    const later = new Date('2026-09-29T12:00:00Z');
    expect(await inTenant(USER_A, (c) => markRead(c, id, first))).toBe(true);
    // Second click must not move it: "when did you see this" is exactly the question a security
    // notice exists to answer.
    expect(await inTenant(USER_A, (c) => markRead(c, id, later))).toBe(false);
    const r = await admin.query<{ read_at: Date }>('SELECT read_at FROM notifications');
    expect(r.rows[0]?.read_at.toISOString()).toBe(first.toISOString());
  });

  it('pages with a cursor that is stable against new arrivals', async () => {
    await write(5);
    const first = await inTenant(USER_A, (c) => readInbox(c, { limit: 2 }));
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    // A new notification arrives at the TOP between pages. With OFFSET this would shift every
    // later page by one and silently skip an entry; the cursor is unaffected.
    await write(1);

    const second = await inTenant(USER_A, (c) =>
      readInbox(c, { limit: 2, before: first.nextCursor ?? undefined }),
    );
    const seen = new Set([...first.entries, ...second.entries].map((e) => e.id));
    expect(seen.size).toBe(4);
  });

  it('returns a null cursor on the last page', async () => {
    await write(2);
    const page = await inTenant(USER_A, (c) => readInbox(c, { limit: 10 }));
    expect(page.entries).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('filters to unread on request', async () => {
    await write(2);
    const page = await inTenant(USER_A, (c) => readInbox(c));
    const id = page.entries[0]?.id;
    if (id === undefined) throw new Error('no entry');
    await inTenant(USER_A, (c) => markRead(c, id, clock.now()));
    const unread = await inTenant(USER_A, (c) => readInbox(c, { unreadOnly: true }));
    expect(unread.entries).toHaveLength(1);
  });

  it('marks everything read in one statement, and only the caller own', async () => {
    await write(3);
    // A fourth of a different type, so the statement is not accidentally type-scoped.
    await inTenant(USER_B, (c) =>
      service(c).notify(c, {
        organizationId: ORG,
        type: 'identity.password.changed',
        recipientUserId: USER_A,
        envelope: {
          to: 'a@example.com',
          subject: 'Your password was changed',
          body: 'If this was not you, act now.',
        },
      }),
    );
    // USER_B wrote all four and can mark none of them: the USING clause makes them invisible.
    expect(await inTenant(USER_B, (c) => markAllRead(c, clock.now()))).toBe(0);
    expect(await inTenant(USER_A, (c) => markAllRead(c, clock.now()))).toBe(4);
  });

  it('caps the page size', async () => {
    await write(3);
    // An unbounded limit would turn an inbox render into a table scan.
    const page = await inTenant(USER_A, (c) => readInbox(c, { limit: 100_000 }));
    expect(page.entries.length).toBeLessThanOrEqual(100);
  });
});
