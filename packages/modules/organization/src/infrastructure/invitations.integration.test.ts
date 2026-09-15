/**
 * Creating invitations — real PostgreSQL, real RLS, real authorization.
 *
 * The inviter's side: who may invite, into which workspace, carrying which role, and what a
 * duplicate does. Every actor is resolved through `resolveActorContext`, so the permission
 * checks are the production ones rather than a fixture's idea of them.
 *
 * Redemption lives in the acceptance suites; the two have opposite starting points.
 */

import { withTenant } from '@growth-os/db';
import { ConflictError, ForbiddenError, ValidationError } from '@growth-os/errors';
import { stopSharedCluster } from '@growth-os/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgencyFixture,
  buildAgencyFixture,
  createRecorder,
} from '../__testing__/agency-fixture.js';
import {
  createInvitationHarness,
  type InvitationHarness,
} from '../__testing__/invitation-harness.js';
import { resendInvitation } from '../application/index.js';
import { createInvitationRepository, createRoleReader } from './invitation-repository.js';

let fx: AgencyFixture;
let h: InvitationHarness;
const recorder = createRecorder();

beforeAll(async () => {
  fx = await buildAgencyFixture();
  h = createInvitationHarness(fx, recorder);
}, 180_000);

afterAll(async () => {
  await fx.close();
  await stopSharedCluster();
});

beforeEach(async () => {
  await fx.admin.query('DELETE FROM invitations');
  recorder.reset();
  h.delivered.length = 0;
});

const invite: InvitationHarness['invite'] = (...a) => h.invite(...a);

describe('case 1 — a valid invitation', () => {
  it('creates a pending invitation and stores only the token hash', async () => {
    const created = await invite(fx.ownerUser, {
      email: 'new@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    // `<organizationId>.<secret>`: a uuid, a dot, and 256 bits of base64url (ADR-0018).
    const [hint, secret] = [
      created.token.slice(0, created.token.indexOf('.')),
      created.token.slice(created.token.indexOf('.') + 1),
    ];
    expect(hint).toBe(fx.agencyOrg);
    expect(secret).toHaveLength(43);

    const stored = await fx.admin.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM invitations',
    );
    expect(stored.rowCount).toBe(1);
    // sha256, 32 bytes, and not the token in any encoding.
    expect(stored.rows[0]?.token_hash).toHaveLength(32);
    expect(stored.rows[0]?.token_hash.toString('base64url')).not.toBe(created.token);
    expect(stored.rows[0]?.token_hash.toString('base64url')).not.toBe(secret);
  });

  it('keeps the token out of the audit log', async () => {
    const created = await invite(fx.ownerUser, {
      email: 'new@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    expect(JSON.stringify(recorder.events)).not.toContain(created.token);
  });
});

describe('cases 7-8 — unauthorized inviter and escalation', () => {
  it('case 7: refuses an inviter without the invite permission', async () => {
    await expect(
      invite(fx.editorUser, {
        email: 'nope@agency.test',
        roleSlug: 'viewer',
        scope: { kind: 'workspace', workspaceId: fx.acme },
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  /**
   * CASE 8 — THE ESCALATION. An admin holds `organization.member:invite`; without the subset
   * check that permission is a silent route to owner.
   */
  it('case 8: an admin cannot invite an owner', async () => {
    await expect(
      invite(fx.adminUser, {
        email: 'escalate@agency.test',
        roleSlug: 'owner',
        scope: { kind: 'organization' },
      }),
    ).rejects.toThrow(/cannot grant access beyond your own/i);

    expect(recorder.events.map((e) => e.action)).toContain(
      'organization.invitation.escalation_refused',
    );
    expect((await fx.admin.query('SELECT 1 FROM invitations')).rowCount).toBe(0);
  });

  it('an owner CAN invite an admin', async () => {
    await expect(
      invite(fx.ownerUser, {
        email: 'newadmin@agency.test',
        roleSlug: 'admin',
        scope: { kind: 'organization' },
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a role granted at the wrong scope', async () => {
    await expect(
      invite(fx.ownerUser, {
        email: 'wrongscope@agency.test',
        roleSlug: 'editor',
        scope: { kind: 'organization' },
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('case 12 — duplicates', () => {
  it('case 12: refuses a duplicate outstanding invitation', async () => {
    const args = {
      email: 'dup@agency.test',
      roleSlug: 'editor' as const,
      scope: { kind: 'workspace' as const, workspaceId: fx.acme },
    };
    await invite(fx.ownerUser, args);
    await expect(invite(fx.ownerUser, args)).rejects.toThrow(ConflictError);
  });
});

describe('case 6 — workspace reach', () => {
  /** CASE 6 — a workspace the inviter cannot reach. */
  it('case 6: refuses inviting into a workspace the inviter cannot reach', async () => {
    await expect(
      invite(fx.editorUser, {
        email: 'elsewhere@agency.test',
        roleSlug: 'viewer',
        scope: { kind: 'workspace', workspaceId: fx.borealis },
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

/**
 * The delivery contract.
 *
 * An invitation nobody receives is not an invitation, so delivery is part of creating one
 * rather than a side effect of it. The properties worth pinning are about WHERE the token
 * goes: to the notifier, addressed to the invited address, and to no other channel.
 */
describe('notification contract', () => {
  it('hands the notifier everything an invitation email needs, and the token once', async () => {
    const created = await invite(fx.ownerUser, {
      email: 'new@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });

    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toEqual({
      invitationId: created.invitationId,
      organizationId: fx.agencyOrg,
      organizationName: 'Northwind',
      email: 'new@agency.test',
      token: created.token,
      roleSlug: 'editor',
      invitedByUserId: fx.ownerUser,
      expiresAt: created.expiresAt,
      resent: false,
    });
    // The one place the token is allowed to be. Not the audit log, not anywhere else.
    expect(JSON.stringify(recorder.events)).not.toContain(created.token);
  });

  it('addresses the delivery to the INVITED address, not to the inviter', async () => {
    await invite(fx.ownerUser, {
      email: 'new@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    expect(h.delivered[0]?.email).toBe('new@agency.test');
    expect(h.delivered[0]?.email).not.toBe('owner@agency.test');
  });

  it('marks a resend as one, so the recipient can be told the old link is dead', async () => {
    const first = await invite(fx.ownerUser, {
      email: 'again@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    const ctx = await fx.actorFor(fx.ownerUser);
    const second = await withTenant(
      fx.db.pool,
      {
        organizationId: fx.agencyOrg,
        userId: fx.ownerUser,
        workspaceIds: ctx.accessibleWorkspaceIds,
      },
      async (tx) =>
        await resendInvitation(
          {
            ...h.deps,
            invitations: createInvitationRepository(tx.client),
            roles: createRoleReader(tx.client),
          },
          ctx,
          first.invitationId,
        ),
    );

    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]?.resent).toBe(true);
    expect(h.delivered[1]?.token).toBe(second?.token);
    // A NEW token, so the previous message is worthless even if it was intercepted.
    expect(second?.token).not.toBe(first.token);
  });

  /**
   * A send that fails must leave NOTHING behind. The alternative — an invitation row nobody
   * received a link for — looks successful to the inviter and is only discovered when the
   * invitee says they never got it, by which time the duplicate check blocks a retry.
   */
  it('a failed delivery rolls the invitation back entirely', async () => {
    h.failNextDelivery(new Error('smtp unavailable'));
    await expect(
      invite(fx.ownerUser, {
        email: 'undelivered@agency.test',
        roleSlug: 'editor',
        scope: { kind: 'workspace', workspaceId: fx.acme },
      }),
    ).rejects.toThrow(/smtp unavailable/);

    expect((await fx.admin.query('SELECT 1 FROM invitations')).rowCount).toBe(0);

    // And the address is free to be invited again — not blocked by a ghost row.
    const retried = await invite(fx.ownerUser, {
      email: 'undelivered@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    expect(retried.token).toBeDefined();
  });
});
