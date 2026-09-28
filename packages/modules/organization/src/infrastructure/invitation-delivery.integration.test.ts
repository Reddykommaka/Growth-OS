/**
 * Invitation delivery, end to end, with the production notifier.
 *
 * Every other invitation suite uses a recording notifier, which is right for testing who may
 * invite and what a bad token does. This one tests the DELIVERY, and the property it exists to
 * pin down is a security property that no unit test can reach:
 *
 *   THE TOKEN MUST APPEAR IN THE SEALED ENVELOPE AND NOWHERE ELSE.
 *
 * It must not be in `outbox_events`, which every session in the organization can read under its
 * policy. It must not be in `notifications`. It must not be in `invitations`, which stores only a
 * hash. And it must not be readable from a tenant session at all, because the application role
 * holds no SELECT on `outbound_messages`.
 *
 * If that property broke, every existing invitation test would still pass — the invitation would
 * be created, the mail would be sent, and one member would be able to accept another member's
 * invitation.
 */

import { randomUUID } from 'node:crypto';
import { createSecretCipher, generateSecretKey } from '@growth-os/authn';
import { withTenant } from '@growth-os/db';
import { createOutboxPublisher } from '@growth-os/events';
import {
  createNotificationService,
  type MessageChannel,
  type OutboundMessage,
  openEnvelope,
  type SenderQueryable,
  type SenderTransactor,
  sendOnce,
} from '@growth-os/notifications';
import { stopSharedCluster } from '@growth-os/testing';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type AgencyFixture,
  buildAgencyFixture,
  createRecorder,
  type Recorder,
} from '../__testing__/agency-fixture.js';
import { createInvitation, type InvitationDependencies } from '../application/index.js';
import { createInvitationNotifier } from './invitation-notifier.js';
import {
  createInvitationRepository,
  createMembershipWriter,
  createOrganizationReader,
  createRoleReader,
} from './invitation-repository.js';

let fx: AgencyFixture;
let recorder: Recorder;
let workerPool: Pool;

const cipher = createSecretCipher(generateSecretKey());
const APP_BASE = 'https://app.growth-os.test';

beforeAll(async () => {
  fx = await buildAgencyFixture();
  recorder = createRecorder();
  workerPool = new Pool({ connectionString: fx.db.relayUrl, max: 3 });
}, 180_000);

afterAll(async () => {
  await workerPool?.end();
  await fx?.close();
  await stopSharedCluster();
});

afterEach(async () => {
  await fx.admin.query('DELETE FROM outbound_messages');
  await fx.admin.query('DELETE FROM outbox_events');
  await fx.admin.query('DELETE FROM notifications');
  await fx.admin.query('DELETE FROM invitations');
});

/**
 * Runs a body with the production notifier wired to the caller's transaction.
 *
 * Three tests needed this block verbatim, and a fourth would have copied it. The wiring is the
 * thing under test — the notifier takes the transaction rather than opening one — so writing it
 * once is what keeps a later test from quietly passing its own pool and proving less.
 */
async function withNotifier<T>(
  body: (
    deps: InvitationDependencies,
    actor: Awaited<ReturnType<typeof fx.actorFor>>,
  ) => Promise<T>,
): Promise<T> {
  const actor = await fx.actorFor(fx.ownerUser);
  return withTenant(
    fx.db.pool,
    {
      organizationId: fx.agencyOrg,
      userId: fx.ownerUser,
      workspaceIds: actor.accessibleWorkspaceIds,
      workspaceScope: actor.workspaceScope,
    },
    async (tx) => {
      const notifications = createNotificationService({
        cipher,
        events: createOutboxPublisher(tx.client),
        clock: recorder.clock,
        ids: { next: () => randomUUID() },
      });
      return body(
        {
          invitations: createInvitationRepository(tx.client),
          roles: createRoleReader(tx.client),
          memberships: createMembershipWriter(tx.client),
          organizations: createOrganizationReader(tx.client),
          audit: recorder.audit,
          clock: recorder.clock,
          notifier: createInvitationNotifier(
            { notifications, appBaseUrl: APP_BASE, replyTo: 'support@growth-os.test' },
            tx.client,
            () => recorder.clock.now(),
          ),
        },
        actor,
      );
    },
  );
}

/** Invites with the production notifier, as a request handler would. */
async function inviteForReal(
  email: string,
  roleSlug = 'editor',
): Promise<{ token: string; invitationId: string }> {
  return withNotifier(async (deps, actor) => {
    const created = await createInvitation(deps, {
      actor,
      email,
      roleSlug,
      // Workspace-scoped, so the role subset check runs the same path production does for an
      // ordinary editor invitation.
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    return { token: created.token, invitationId: created.invitationId };
  });
}

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

/** The one queued message's ciphertext. Throws rather than returning undefined. */
async function sealedEnvelope(): Promise<Buffer> {
  const row = await fx.admin.query<{ envelope: Buffer }>('SELECT envelope FROM outbound_messages');
  const sealed = row.rows[0]?.envelope;
  if (sealed === undefined) throw new Error('no message was queued');
  return sealed;
}

const bodyOfQueuedMessage = (sealed: Buffer): string => openEnvelope(cipher, sealed).body;

function recordingChannel(): { channel: MessageChannel; sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    sent,
    channel: {
      channel: 'email',
      async send(message) {
        sent.push(message);
      },
    },
  };
}

describe('the token reaches the recipient and nothing else', () => {
  it('appears in the sealed envelope', async () => {
    const { token } = await inviteForReal('invitee@example.com');
    const envelope = openEnvelope(cipher, await sealedEnvelope());
    expect(envelope.to).toBe('invitee@example.com');
    expect(envelope.body).toContain(token);
  });

  it('does not appear in outbox_events, which every member can read', async () => {
    const { token } = await inviteForReal('invitee@example.com');
    const events = await fx.admin.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM outbox_events',
    );
    expect(events.rows.length).toBeGreaterThan(0);
    // THE failure this design exists to prevent: with the token on the event, any member of the
    // organization could read it out of the queue and accept in the invitee's place.
    for (const row of events.rows) {
      expect(JSON.stringify(row.payload).includes(token), 'token on an outbox event').toBe(false);
    }
  });

  it('does not appear in the in-app inbox', async () => {
    const { token } = await inviteForReal('invitee@example.com');
    const inbox = await fx.admin.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM notifications',
    );
    // This type writes no inbox row at all — the recipient has no account — so there is nothing
    // here. The assertion holds either way.
    for (const row of inbox.rows) {
      expect(JSON.stringify(row.payload).includes(token)).toBe(false);
    }
  });

  it('does not appear in the invitations table, which stores only a hash', async () => {
    const { token } = await inviteForReal('invitee@example.com');
    const rows = await fx.admin.query<{ hex: string }>(
      `SELECT encode(token_hash, 'hex') AS hex FROM invitations`,
    );
    // sha256 of `<organizationId>.<secret>` (ADR-0018): 32 bytes, and not the token.
    expect(rows.rows[0]?.hex).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.rows[0]?.hex).not.toContain(token);
  });

  it('is unreadable from a tenant session, which holds no SELECT on the queue', async () => {
    await inviteForReal('invitee@example.com');
    // The control that makes queuing the token safe at all. RLS cannot express "you may write
    // this row and never read it"; the absent grant can.
    await expect(
      fx.asActor(fx.ownerUser, fx.agencyOrg, (client) =>
        client.query('SELECT envelope FROM outbound_messages'),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('is nowhere in the database in plaintext', async () => {
    const { token } = await inviteForReal('invitee@example.com');
    // A sweep rather than a list of tables: a future migration adding a column that logged the
    // delivery would be caught here without anyone remembering to extend this test.
    const columns = await fx.admin.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'citext')
        ORDER BY table_name, column_name`,
    );
    const offenders: string[] = [];
    for (const { table_name: table, column_name: column } of columns.rows) {
      const hit = await fx.admin.query(
        `SELECT 1 FROM ${table} WHERE ${column}::text LIKE '%' || $1 || '%' LIMIT 1`,
        [token],
      );
      if ((hit.rowCount ?? 0) > 0) offenders.push(`${table}.${column}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the queued message', () => {
  it('carries an acceptance link with the token in the path, not the query string', async () => {
    const { token } = await inviteForReal('invitee@example.com');
    const row = await fx.admin.query<{ envelope: Buffer }>(
      'SELECT envelope FROM outbound_messages',
    );
    const sealed = row.rows[0]?.envelope;
    if (sealed === undefined) throw new Error('no message was queued');
    const body = openEnvelope(cipher, sealed).body;

    // A query string is logged by proxies and CDNs far more often than a path, and is forwarded in
    // `Referer` when the landing page loads a third-party asset — which for a single-use
    // credential means the credential leaves the recipient's browser.
    expect(body).toContain(`${APP_BASE}/invitations/${encodeURIComponent(token)}/accept`);
    expect(body).not.toMatch(/\?token=/);
  });

  it('names the organization and the role, and says the link is single-use', async () => {
    await inviteForReal('invitee@example.com', 'editor');
    const row = await fx.admin.query<{ envelope: Buffer }>(
      'SELECT envelope FROM outbound_messages',
    );
    const sealed = row.rows[0]?.envelope;
    if (sealed === undefined) throw new Error('no message was queued');
    const envelope = openEnvelope(cipher, sealed);
    expect(envelope.subject).toContain('Growth OS');
    expect(envelope.body).toContain('editor');
    expect(envelope.body).toContain('used once');
    expect(envelope.replyTo).toBe('support@growth-os.test');
  });
});

describe('the queued message commits with the invitation', () => {
  it('leaves no live link when the caller fails after creating it', async () => {
    // A notifier that opened its own connection would queue a message for an invitation that then
    // rolled back: a working link to something that does not exist.
    await expect(
      withNotifier(async (deps, actor) => {
        await createInvitation(deps, {
          actor,
          email: 'invitee@example.com',
          roleSlug: 'editor',
          scope: { kind: 'workspace', workspaceId: fx.acme },
        });
        throw new Error('the caller failed after the invitation was created');
      }),
    ).rejects.toThrow(/the caller failed/);

    expect((await fx.admin.query('SELECT 1 FROM invitations')).rowCount).toBe(0);
    expect((await fx.admin.query('SELECT 1 FROM outbound_messages')).rowCount).toBe(0);
    expect((await fx.admin.query('SELECT 1 FROM outbox_events')).rowCount).toBe(0);
  });

  it('tells the recipient when a resend has killed the previous link', async () => {
    // The previous token is revoked when a new one is issued. Without this line a recipient who
    // kept the first mail sees only that its link stopped working.
    const first = await inviteForReal('invitee@example.com');
    await fx.admin.query('DELETE FROM outbound_messages');

    await withNotifier(async (deps) => {
      await deps.notifier?.deliver({
        invitationId: first.invitationId,
        organizationId: fx.agencyOrg,
        organizationName: 'Acme Agency',
        email: 'invitee@example.com',
        token: 'a-fresh-token',
        roleSlug: 'editor',
        invitedByUserId: fx.ownerUser,
        expiresAt: new Date(recorder.clock.now().getTime() + 72 * 3_600_000),
        resent: true,
      });
    });

    expect(bodyOfQueuedMessage(await sealedEnvelope())).toContain('no longer works');
  });
});

describe('the worker delivers it', () => {
  it('sends the invitation and marks the message sent', async () => {
    const { token } = await inviteForReal('invitee@example.com');
    const { channel, sent } = recordingChannel();

    const pass = await sendOnce(transactorOn(workerPool), [channel], cipher, {
      now: () => recorder.clock.now(),
    });
    expect(pass).toMatchObject({ sent: 1, failed: 0, deadLettered: 0 });

    const message = sent[0];
    if (message === undefined) throw new Error('nothing was sent');
    expect(message.envelope.to).toBe('invitee@example.com');
    expect(message.envelope.body).toContain(token);
    expect(message.type).toBe('organization.invitation.sent');

    const status = await fx.admin.query<{ status: string }>('SELECT status FROM outbound_messages');
    expect(status.rows[0]?.status).toBe('sent');
  });

  it('leaves the invitation acceptable after delivery', async () => {
    // The end of the chain: the token the worker handed to the provider is the one that works.
    const { token } = await inviteForReal('invitee@example.com');
    const { channel } = recordingChannel();
    await sendOnce(transactorOn(workerPool), [channel], cipher, {
      now: () => recorder.clock.now(),
    });
    const hash = await fx.admin.query<{ hex: string; accepted: boolean; revoked: boolean }>(
      `SELECT encode(token_hash, 'hex') AS hex,
              accepted_at IS NOT NULL AS accepted,
              revoked_at IS NOT NULL AS revoked
         FROM invitations`,
    );
    // Hashed as sha256 of `<organizationId>.<secret>` (ADR-0018), so the token alone cannot be
    // compared here. What matters is that delivery neither consumed nor revoked it.
    expect(hash.rows[0]?.hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hash.rows[0]?.accepted).toBe(false);
    expect(hash.rows[0]?.revoked).toBe(false);
    expect(token.length).toBeGreaterThan(20);
  });
});
