/**
 * The notification service against a real schema.
 *
 * Three properties cannot be tested any other way: that the inbox row, the queued message and the
 * domain event commit together; that a notification is invisible to anyone but its recipient; and
 * that the application role can stage a sealed message it is unable to read back.
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
import { openEnvelope } from './envelope.js';
import { markRead, readInbox } from './inbox.js';
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

const passwordChanged = {
  type: 'identity.password.changed',
  organizationId: ORG,
  recipientUserId: USER_A,
  envelope: {
    to: 'a@example.com',
    subject: 'Your password was changed',
    body: 'If this was not you, act now.',
  },
  payload: { at: '2026-09-28T12:00:00Z' },
} as const;

describe('notify writes three things, or none', () => {
  it('writes the inbox row, queues the message and stages the event', async () => {
    const result = await inTenant(USER_B, (c) => service(c).notify(c, passwordChanged));

    expect(result.notificationId).not.toBeNull();
    expect(result.messageIds).toHaveLength(1);
    expect(result.eventId).toMatch(/^[0-9a-f-]{36}$/);

    const inbox = await admin.query('SELECT type, recipient_user_id FROM notifications');
    expect(inbox.rows).toEqual([{ type: 'identity.password.changed', recipient_user_id: USER_A }]);
    const queued = await admin.query('SELECT channel, status, type FROM outbound_messages');
    expect(queued.rows).toEqual([
      { channel: 'email', status: 'pending', type: 'identity.password.changed' },
    ]);
    const events = await admin.query('SELECT event_name FROM outbox_events');
    expect(events.rows).toEqual([{ event_name: 'platform.notification.queued' }]);
  });

  it('leaves nothing behind when the transaction rolls back', async () => {
    // The property the whole design rests on. An inbox row with no email is a notification the
    // user never learns about; an email with no inbox row is one they cannot find again.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await setTenantContext(client, { organizationId: ORG, userId: USER_B, workspaceIds: [] });
      await service(client).notify(client, passwordChanged);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    for (const table of ['notifications', 'outbound_messages', 'outbox_events']) {
      const r = await admin.query(`SELECT 1 FROM ${table}`);
      expect(r.rowCount, table).toBe(0);
    }
  });

  it('records who caused it, so a fabricated notification is attributable', async () => {
    await inTenant(USER_B, (c) =>
      service(c).notify(c, { ...passwordChanged, actorUserId: USER_B }),
    );
    const r = await admin.query<{ actor_user_id: string }>(
      'SELECT actor_user_id FROM notifications',
    );
    expect(r.rows[0]?.actor_user_id).toBe(USER_B);
  });

  it('refuses an unknown type rather than writing a notification nothing renders', async () => {
    await expect(
      inTenant(USER_B, (c) =>
        service(c).notify(c, { ...passwordChanged, type: 'identity.password.imagined' }),
      ),
    ).rejects.toThrow(/Unknown notification type/);
  });

  it('refuses an in-app type with no recipient', async () => {
    await expect(
      inTenant(USER_B, (c) =>
        service(c).notify(c, { ...passwordChanged, recipientUserId: undefined }),
      ),
    ).rejects.toThrow(/needs a recipient user/);
  });

  it('refuses a channelled type with no rendered envelope', async () => {
    await expect(
      inTenant(USER_B, (c) => service(c).notify(c, { ...passwordChanged, envelope: undefined })),
    ).rejects.toThrow(/needs a rendered envelope/);
  });

  it('refuses an inbox payload carrying a credential', async () => {
    // A notification says that something happened; it never needs the credential involved. The
    // inbox row is rendered into a page, and pages are screenshotted and pasted into tickets.
    for (const key of ['token', 'apiKey', 'password', 'totpSecret', 'recoveryCodes']) {
      await expect(
        inTenant(USER_B, (c) =>
          service(c).notify(c, { ...passwordChanged, payload: { [key]: 'x' } }),
        ),
        key,
      ).rejects.toThrow(/forbidden payload key/);
    }
  });

  it('allows a payload that references a credential by identity', async () => {
    await expect(
      inTenant(USER_B, (c) =>
        service(c).notify(c, { ...passwordChanged, payload: { apiKeyId: 'ak_1' } }),
      ),
    ).resolves.toBeDefined();
  });

  it('writes no inbox row for a type whose recipient has no account', async () => {
    await inTenant(USER_B, (c) =>
      service(c).notify(c, {
        organizationId: ORG,
        type: 'organization.invitation.sent',
        envelope: { to: 'new@example.com', subject: 'Join Acme', body: 'link' },
      }),
    );
    expect((await admin.query('SELECT 1 FROM notifications')).rowCount).toBe(0);
    expect((await admin.query('SELECT 1 FROM outbound_messages')).rowCount).toBe(1);
  });

  it('queues nothing for an in-app-only type', async () => {
    await inTenant(USER_B, (c) =>
      service(c).notify(c, {
        organizationId: ORG,
        type: 'billing.limit.reached',
        recipientUserId: USER_A,
        payload: { capability: 'social.scheduling' },
      }),
    );
    expect((await admin.query('SELECT 1 FROM notifications')).rowCount).toBe(1);
    expect((await admin.query('SELECT 1 FROM outbound_messages')).rowCount).toBe(0);
  });
});

describe('the event carries identity and no content', () => {
  it('names the type and the ids, and nothing that was written to the envelope', async () => {
    await inTenant(USER_B, (c) => service(c).notify(c, passwordChanged));
    const r = await admin.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM outbox_events',
    );
    const payload = r.rows[0]?.payload ?? {};
    expect(Object.keys(payload).sort()).toEqual([
      'channels',
      'messageIds',
      'notificationId',
      'notificationType',
    ]);
    // The event is readable by every session in the organization, so the subject, body and
    // address must not be on it. This is the check that would fail if someone "helpfully" added
    // the subject for debugging.
    const text = JSON.stringify(payload);
    for (const content of ['a@example.com', 'Your password was changed', 'act now']) {
      expect(text.includes(content), content).toBe(false);
    }
  });
});

describe('a notification is personal', () => {
  it('is invisible to another member of the same organization', async () => {
    await inTenant(USER_B, (c) => service(c).notify(c, passwordChanged));
    // USER_B wrote it, for USER_A. USER_B cannot read it back: without the recipient clause, any
    // member could read every member's inbox with raw SQL.
    const seen = await inTenant(USER_B, (c) => readInbox(c));
    expect(seen.entries).toEqual([]);
    const own = await inTenant(USER_A, (c) => readInbox(c));
    expect(own.entries).toHaveLength(1);
  });

  it('is invisible to the same user acting in another organization', async () => {
    await inTenant(USER_B, (c) => service(c).notify(c, passwordChanged));
    const seen = await inTenant(USER_A, (c) => readInbox(c), ORG_OTHER);
    expect(seen.entries).toEqual([]);
  });

  it('cannot be marked read by anyone but its recipient', async () => {
    const { notificationId } = await inTenant(USER_B, (c) => service(c).notify(c, passwordChanged));
    if (notificationId === null) throw new Error('no notification was written');
    // The USING clause governs UPDATE's row selection, so this finds nothing rather than being
    // refused — the row is not merely unwritable, it is invisible.
    expect(await inTenant(USER_B, (c) => markRead(c, notificationId, clock.now()))).toBe(false);
    expect(await inTenant(USER_A, (c) => markRead(c, notificationId, clock.now()))).toBe(true);
  });

  it('cannot be written into another organization', async () => {
    await expect(
      inTenant(USER_B, (c) =>
        service(c).notify(c, { ...passwordChanged, organizationId: ORG_OTHER }),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });
});

describe('the outbound queue is write-only for the application', () => {
  it('refuses a SELECT, so a staged token cannot be read back', async () => {
    await inTenant(USER_B, (c) => service(c).notify(c, passwordChanged));
    // THE control that makes queuing an invitation token safe. RLS cannot express "you may write
    // this and never read it"; the absent grant can.
    await expect(
      inTenant(USER_B, (c) => c.query('SELECT envelope FROM outbound_messages')),
    ).rejects.toThrow(/permission denied/);
  });

  it('refuses an UPDATE, so a session cannot suppress a message it queued', async () => {
    await inTenant(USER_B, (c) => service(c).notify(c, passwordChanged));
    // Setting status = 'sent' would suppress the message, and the suppression would be
    // indistinguishable from a delivery.
    await expect(
      inTenant(USER_B, (c) => c.query(`UPDATE outbound_messages SET status = 'sent'`)),
    ).rejects.toThrow(/permission denied/);
  });

  it('refuses a DELETE', async () => {
    await inTenant(USER_B, (c) => service(c).notify(c, passwordChanged));
    await expect(inTenant(USER_B, (c) => c.query('DELETE FROM outbound_messages'))).rejects.toThrow(
      /permission denied/,
    );
    expect((await admin.query('SELECT 1 FROM outbound_messages')).rowCount).toBe(1);
  });

  it('stores a sealed envelope that the database alone cannot open', async () => {
    await inTenant(USER_B, (c) => service(c).notify(c, passwordChanged));
    const r = await admin.query<{ envelope: Buffer }>('SELECT envelope FROM outbound_messages');
    const sealed = r.rows[0]?.envelope;
    if (sealed === undefined) throw new Error('no envelope');
    // A superuser reading the table gets ciphertext. The key is in the secret manager, so a dump
    // yields nothing.
    expect(sealed.toString('binary')).not.toContain('a@example.com');
    expect(openEnvelope(cipher, sealed).to).toBe('a@example.com');
  });
});
