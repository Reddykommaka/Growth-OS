/**
 * The outbound sender against a real queue, running as the worker's role.
 *
 * The properties here are the ones that differ from the outbox relay, and each difference is a
 * decision rather than an omission: no ordering guarantee to preserve, so one bad address must not
 * block the queue; and a decryption failure is terminal rather than retryable, because a wrong key
 * fails identically every time and retrying would bury a key-rotation mistake under a growing
 * queue.
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
import { Client, Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MessageEnvelope } from './envelope.js';
import type { Queryable } from './ports.js';
import {
  type MessageChannel,
  type OutboundMessage,
  readOutboundLag,
  type SenderQueryable,
  type SenderTransactor,
  sendOnce,
} from './sender.js';
import { createNotificationService } from './service.js';

let db: TestDatabase;
let admin: Client;
let workerPool: Pool;

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';

const cipher = createSecretCipher(generateSecretKey());
const clock = { now: () => new Date('2026-09-28T12:00:00Z') };

beforeAll(async () => {
  db = await acquireTestDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();
  workerPool = new Pool({ connectionString: db.relayUrl, max: 5 });

  await admin.query(
    `INSERT INTO organizations (id, name, slug, kind) VALUES ($1, 'Acme', 'acme', 'agency')`,
    [ORG],
  );
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, 'a@example.com')`, [USER]);
}, 120_000);

afterAll(async () => {
  await workerPool?.end();
  await admin?.end();
  await db?.close();
  await stopSharedCluster();
});

afterEach(async () => {
  await admin.query('DELETE FROM outbound_messages');
  await admin.query('DELETE FROM notifications');
  await admin.query('DELETE FROM outbox_events');
});

function transactorOn(pool: Pool): SenderTransactor {
  return {
    async run(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client as unknown as SenderQueryable);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** Records what it was handed, and can be told to fail for named addresses. */
function recordingChannel(failFor: (message: OutboundMessage) => boolean = () => false): {
  channel: MessageChannel;
  sent: OutboundMessage[];
} {
  const sent: OutboundMessage[] = [];
  return {
    sent,
    channel: {
      channel: 'email',
      async send(message) {
        if (failFor(message)) throw new Error(`provider rejected ${message.envelope.to}`);
        sent.push(message);
      },
    },
  };
}

/** Queues a message the way an application service does: through notify, in a transaction. */
async function queue(to: string, subject = 'Join Acme'): Promise<void> {
  const client: PoolClient = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await setTenantContext(client, { organizationId: ORG, userId: USER, workspaceIds: [] });
    const service = createNotificationService({
      cipher,
      events: createOutboxPublisher(client),
      clock,
      ids: { next: () => randomUUID() },
    });
    await service.notify(client, {
      organizationId: ORG,
      type: 'organization.invitation.sent',
      envelope: { to, subject, body: 'Open this link to accept.' },
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const statuses = async (): Promise<
  { status: string; attempts: number; sent: boolean; dead: boolean }[]
> => {
  const r = await admin.query<{
    status: string;
    attempts: number;
    sent: boolean;
    dead: boolean;
  }>(
    `SELECT status, attempts, sent_at IS NOT NULL AS sent, dead_lettered_at IS NOT NULL AS dead
       FROM outbound_messages ORDER BY created_at`,
  );
  return r.rows;
};

describe('a healthy pass', () => {
  it('sends every pending message and marks it', async () => {
    await queue('one@example.com');
    await queue('two@example.com');
    const { channel, sent } = recordingChannel();

    const pass = await sendOnce(transactorOn(workerPool), [channel], cipher, { now: clock.now });
    expect(pass).toEqual({ sent: 2, failed: 0, deadLettered: 0, unroutable: 0 });
    expect(sent.map((m) => m.envelope.to).sort()).toEqual(['one@example.com', 'two@example.com']);
    expect((await statuses()).every((r) => r.status === 'sent' && r.sent)).toBe(true);
  });

  it('hands the sender the decrypted envelope and nothing less', async () => {
    await queue('one@example.com', 'Join Acme on Growth OS');
    const { channel, sent } = recordingChannel();
    await sendOnce(transactorOn(workerPool), [channel], cipher, { now: clock.now });

    const message = sent[0];
    if (message === undefined) throw new Error('nothing was sent');
    const envelope: MessageEnvelope = message.envelope;
    expect(envelope.to).toBe('one@example.com');
    expect(envelope.subject).toBe('Join Acme on Growth OS');
    expect(envelope.body).toContain('Open this link');
    // The type travels in the clear because the sender routes on it; everything else came out of
    // the ciphertext.
    expect(message.type).toBe('organization.invitation.sent');
    expect(message.organizationId).toBe(ORG);
  });

  it('is a no-op on an empty queue', async () => {
    const { channel, sent } = recordingChannel();
    expect(await sendOnce(transactorOn(workerPool), [channel], cipher)).toEqual({
      sent: 0,
      failed: 0,
      deadLettered: 0,
      unroutable: 0,
    });
    expect(sent).toEqual([]);
  });

  it('does not resend what it already sent', async () => {
    await queue('one@example.com');
    const first = recordingChannel();
    await sendOnce(transactorOn(workerPool), [first.channel], cipher, { now: clock.now });
    const second = recordingChannel();
    await sendOnce(transactorOn(workerPool), [second.channel], cipher, { now: clock.now });
    expect(second.sent).toEqual([]);
  });

  it('respects the batch size', async () => {
    for (const to of ['a@example.com', 'b@example.com', 'c@example.com']) await queue(to);
    const { channel, sent } = recordingChannel();
    await sendOnce(transactorOn(workerPool), [channel], cipher, {
      batchSize: 2,
      now: clock.now,
    });
    expect(sent).toHaveLength(2);
  });
});

describe('failure handling', () => {
  /**
   * THE DIFFERENCE FROM THE RELAY. Mail has no ordering guarantee to preserve, so a failure must
   * not block the queue behind it. The relay deliberately stops an organization at its first
   * failure; doing that here would let one undeliverable address hold up every other tenant's mail.
   */
  it('does not let one bad address hold up the queue', async () => {
    await queue('bad@example.com');
    await queue('good@example.com');
    const { channel, sent } = recordingChannel((m) => m.envelope.to === 'bad@example.com');

    const pass = await sendOnce(transactorOn(workerPool), [channel], cipher, { now: clock.now });
    expect(sent.map((m) => m.envelope.to)).toEqual(['good@example.com']);
    expect(pass).toMatchObject({ sent: 1, failed: 1, deadLettered: 0 });
  });

  it('retries a failure and records the reason', async () => {
    await queue('bad@example.com');
    const { channel } = recordingChannel(() => true);
    await sendOnce(transactorOn(workerPool), [channel], cipher, {
      maxAttempts: 3,
      now: clock.now,
    });
    const rows = await statuses();
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1, dead: false });
    const error = await admin.query<{ last_error: string }>(
      'SELECT last_error FROM outbound_messages',
    );
    expect(error.rows[0]?.last_error).toContain('provider rejected');
  });

  it('dead-letters past the attempt threshold rather than retrying forever', async () => {
    await queue('bad@example.com');
    const { channel } = recordingChannel(() => true);
    const transactor = transactorOn(workerPool);
    for (let attempt = 0; attempt < 3; attempt++) {
      await sendOnce(transactor, [channel], cipher, { maxAttempts: 3, now: clock.now });
    }
    expect((await statuses())[0]).toMatchObject({
      status: 'dead_lettered',
      attempts: 3,
      dead: true,
      sent: false,
    });
  });

  it('never marks a dead-lettered message sent', async () => {
    await queue('bad@example.com');
    const { channel } = recordingChannel(() => true);
    await sendOnce(transactorOn(workerPool), [channel], cipher, {
      maxAttempts: 1,
      now: clock.now,
    });
    // `sent` with no timestamp, or a dead message that also looks sent, would make "did this go
    // out" unanswerable — the first question asked when a customer says they never got it.
    const row = (await statuses())[0];
    expect(row?.sent).toBe(false);
    expect(row?.dead).toBe(true);
  });

  it('truncates a pathological error message', async () => {
    await queue('bad@example.com');
    const channel: MessageChannel = {
      channel: 'email',
      send() {
        return Promise.reject(new Error('x'.repeat(5000)));
      },
    };
    await sendOnce(transactorOn(workerPool), [channel], cipher, {
      maxAttempts: 5,
      now: clock.now,
    });
    const r = await admin.query<{ last_error: string }>('SELECT last_error FROM outbound_messages');
    expect(r.rows[0]?.last_error.length).toBe(1000);
  });
});

describe('what is terminal rather than retryable', () => {
  it('dead-letters a message whose channel has no transport, at once', async () => {
    await queue('one@example.com');
    // No transports registered at all. No number of retries conjures one, and retrying would hide
    // a configuration error behind a growing queue.
    const pass = await sendOnce(transactorOn(workerPool), [], cipher, { now: clock.now });
    expect(pass).toMatchObject({ sent: 0, unroutable: 1, deadLettered: 1 });
    const row = (await statuses())[0];
    expect(row?.status).toBe('dead_lettered');
    const r = await admin.query<{ last_error: string }>('SELECT last_error FROM outbound_messages');
    expect(r.rows[0]?.last_error).toContain('no transport is registered');
  });

  it('dead-letters a message it cannot decrypt, rather than retrying the key', async () => {
    await queue('one@example.com');
    const wrongKey = createSecretCipher(generateSecretKey());
    const { channel, sent } = recordingChannel();

    const pass = await sendOnce(transactorOn(workerPool), [channel], wrongKey, {
      maxAttempts: 5,
      now: clock.now,
    });
    // A wrong key fails identically every time. Retrying would bury a key-rotation mistake under
    // a growing queue instead of surfacing it as a dead letter an operator can see.
    expect(sent).toEqual([]);
    expect(pass.deadLettered).toBe(1);
    expect((await statuses())[0]?.status).toBe('dead_lettered');
  });

  it('dead-letters a tampered envelope rather than sending something else', async () => {
    await queue('one@example.com');
    // GCM's tag is what makes this a failure and not a successfully delivered altered message.
    await admin.query(
      `UPDATE outbound_messages SET envelope = set_byte(envelope, length(envelope) - 1,
         get_byte(envelope, length(envelope) - 1) # 255)`,
    );
    const { channel, sent } = recordingChannel();
    const pass = await sendOnce(transactorOn(workerPool), [channel], cipher, { now: clock.now });
    expect(sent).toEqual([]);
    expect(pass.deadLettered).toBe(1);
  });
});

describe('lag', () => {
  it('reports pending, age and dead-letter depth separately', async () => {
    await queue('one@example.com');
    const before = await readOutboundLag(workerPool as unknown as Queryable);
    expect(before.pending).toBe(1);
    expect(before.oldestSeconds).toBeGreaterThan(0);
    expect(before.deadLettered).toBe(0);

    const { channel } = recordingChannel();
    await sendOnce(transactorOn(workerPool), [channel], cipher, { now: clock.now });
    const after = await readOutboundLag(workerPool as unknown as Queryable);
    expect(after.pending).toBe(0);
    // Null, not zero: "nothing queued" and "a queue that is keeping up" are different states.
    expect(after.oldestSeconds).toBeNull();
  });

  it('excludes dead-lettered messages from the age, so the alert stays meaningful', async () => {
    await queue('bad@example.com');
    const { channel } = recordingChannel(() => true);
    await sendOnce(transactorOn(workerPool), [channel], cipher, {
      maxAttempts: 1,
      now: clock.now,
    });
    const lag = await readOutboundLag(workerPool as unknown as Queryable);
    expect(lag.pending).toBe(0);
    expect(lag.deadLettered).toBe(1);
  });
});

describe('the worker role is bounded', () => {
  it('cannot queue a message itself', async () => {
    // A worker that could write messages could send mail as any tenant, and BYPASSRLS means no
    // policy would stop it.
    await expect(
      workerPool.query(
        `INSERT INTO outbound_messages (id, organization_id, channel, envelope, type)
         VALUES (gen_random_uuid(), $1, 'email', '\\x00'::bytea, 'x')`,
        [ORG],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('cannot read the in-app inbox', async () => {
    // The sender has no business with `notifications`: it delivers to channels. Its reach is
    // asserted by equality in the tenancy sweep; this is the same property from the other side.
    await expect(workerPool.query('SELECT 1 FROM notifications LIMIT 1')).rejects.toThrow(
      /permission denied/,
    );
  });
});
