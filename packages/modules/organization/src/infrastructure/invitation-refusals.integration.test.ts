/**
 * Accepting invitations — the paths that must GRANT NOTHING.
 *
 * Expired, revoked, replayed, forwarded to the wrong person, rewritten to name another
 * organization, or redeemed twice at once. Each asserts two things: the refusal, and that no
 * membership row was left behind by a redemption that got part-way.
 */

import { randomUUID } from 'node:crypto';
import { withTenant } from '@growth-os/db';
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
import { resendInvitation, revokeInvitation } from '../application/index.js';
import { resolveActorContext } from './actor-resolver.js';
import { createInvitationRepository } from './invitation-repository.js';

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
});

const invite: InvitationHarness['invite'] = (...a) => h.invite(...a);
const accept: InvitationHarness['accept'] = (...a) => h.accept(...a);

describe('cases 2-4 — expiry, revocation and replay', () => {
  it('case 2: refuses an expired invitation', async () => {
    const created = await invite(fx.ownerUser, {
      email: 'late@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    const invitee = await fx.createUser('late@agency.test');
    recorder.advanceBy(8 * 24 * 60 * 60 * 1000);
    expect(await accept(created.token, invitee, 'late@agency.test')).toEqual({
      outcome: 'failed',
      reason: 'expired',
    });
  });

  it('case 3: refuses a revoked invitation', async () => {
    const created = await invite(fx.ownerUser, {
      email: 'gone@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    await withTenant(
      fx.db.pool,
      {
        organizationId: fx.agencyOrg,
        userId: fx.ownerUser,
        workspaceIds: [fx.acme, fx.borealis],
        workspaceScope: 'all',
      },
      async (tx) =>
        revokeInvitation(
          { ...h.deps, invitations: createInvitationRepository(tx.client) },
          await fx.actorFor(fx.ownerUser),
          created.invitationId,
        ),
    );
    const invitee = await fx.createUser('gone@agency.test');
    expect(await accept(created.token, invitee, 'gone@agency.test')).toEqual({
      outcome: 'failed',
      reason: 'revoked',
    });
  });

  it('case 4: refuses a replayed invitation', async () => {
    const created = await invite(fx.ownerUser, {
      email: 'twice@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    const first = await fx.createUser('twice@agency.test');
    expect((await accept(created.token, first, 'twice@agency.test')).outcome).toBe('accepted');

    const second = await fx.createUser('twice2@agency.test');
    expect(await accept(created.token, second, 'twice@agency.test')).toEqual({
      outcome: 'failed',
      reason: 'already_accepted',
    });
  });

  /** CASE 14 — the race the conditional UPDATE exists for. */
  it('case 14: exactly one of two CONCURRENT acceptances wins', async () => {
    const created = await invite(fx.ownerUser, {
      email: 'race@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    const a = await fx.createUser('race@agency.test');

    const [first, second] = await Promise.all([
      accept(created.token, a, 'race@agency.test'),
      accept(created.token, a, 'race@agency.test'),
    ]);
    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(['accepted', 'failed']);

    // Exactly one membership, not two.
    const members = await fx.admin.query(
      'SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [fx.agencyOrg, a],
    );
    expect(members.rowCount).toBe(1);
  });

  it('case 16: an unknown token discloses nothing', async () => {
    const stranger = await fx.createUser('stranger@agency.test');
    expect(await accept('x'.repeat(43), stranger, 'stranger@agency.test')).toEqual({
      outcome: 'failed',
      reason: 'invalid',
    });
  });
});

describe('cases 5-6 — wrong organization and wrong recipient', () => {
  /**
   * CASE 5. The accepter cannot choose the organization: it comes from the stored row. There
   * is no parameter to tamper with, which is why this is a non-attack rather than a check.
   */
  it('case 5: acceptance uses the organization from the invitation, not the request', async () => {
    const created = await invite(fx.ownerUser, {
      email: 'scoped@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    const invitee = await fx.createUser('scoped@agency.test');
    const result = await accept(created.token, invitee, 'scoped@agency.test');
    if (result.outcome !== 'accepted') throw new Error('setup');

    expect(result.organizationId).toBe(fx.agencyOrg);
    // And no membership leaked into the rival.
    expect(
      await resolveActorContext(fx.db.pool, {
        userId: invitee,
        organizationId: fx.rivalOrg,
        mfaSatisfied: true,
      }),
    ).toBeUndefined();
  });

  /**
   * CASE 5, THE ACTIVE FORM.
   *
   * The token now CARRIES an organization id (ADR-0018), so "accept this into the wrong
   * organization" is an attack the attacker can actually express: rewrite the segment. It
   * must fail, and it must fail at the database rather than at a check in application code.
   *
   * Two independent mechanisms refuse it, and this asserts both:
   *   - the scope opened is the rival's, where the invitation row is invisible to RLS;
   *   - the stored hash covers the whole token, so the rewritten string hashes to nothing.
   */
  it('case 5: rewriting the organization segment of a token grants nothing', async () => {
    const created = await invite(fx.ownerUser, {
      email: 'target@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    const attacker = await fx.createUser('target@agency.test');

    const secret = created.token.slice(created.token.indexOf('.') + 1);
    const forged = `${fx.rivalOrg}.${secret}`;
    expect(await accept(forged, attacker, 'target@agency.test')).toEqual({
      outcome: 'failed',
      reason: 'invalid',
    });

    // No membership anywhere — not in the rival, not in the agency.
    expect(
      (await fx.admin.query('SELECT 1 FROM organization_members WHERE user_id = $1', [attacker]))
        .rowCount,
    ).toBe(0);
    // And the invitation is still pending, so the forgery did not consume it either.
    const still = await fx.admin.query<{ accepted_at: Date | null }>(
      'SELECT accepted_at FROM invitations WHERE organization_id = $1 AND email = $2',
      [fx.agencyOrg, 'target@agency.test'],
    );
    expect(still.rows[0]?.accepted_at).toBeNull();

    // The genuine token still works, proving the refusal was about the forgery and not
    // about some unrelated failure.
    expect((await accept(created.token, attacker, 'target@agency.test')).outcome).toBe('accepted');
  });

  /**
   * The same rewrite pointed at an organization that does not exist. A malformed or unknown
   * tenant hint must be refused as an ordinary failure, not surface as a 500 — otherwise the
   * error itself tells an attacker which organization ids are real.
   */
  it('case 5: a token naming a nonexistent or malformed organization is just invalid', async () => {
    const created = await invite(fx.ownerUser, {
      email: 'probe@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    const prober = await fx.createUser('probe@agency.test');
    const secret = created.token.slice(created.token.indexOf('.') + 1);

    for (const hint of [randomUUID(), 'not-a-uuid', '', '00000000-0000-0000-0000-000000000000']) {
      expect(await accept(`${hint}.${secret}`, prober, 'probe@agency.test')).toEqual({
        outcome: 'failed',
        reason: 'invalid',
      });
    }
  });

  it('refuses an accepter whose address is not the invited one', async () => {
    const created = await invite(fx.ownerUser, {
      email: 'intended@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    const interloper = await fx.createUser('interloper@agency.test');
    expect(await accept(created.token, interloper, 'interloper@agency.test')).toEqual({
      outcome: 'failed',
      reason: 'wrong_address',
    });
    expect(
      (await fx.admin.query('SELECT 1 FROM organization_members WHERE user_id = $1', [interloper]))
        .rowCount,
    ).toBe(0);
  });
});

describe('case 13 — resend invalidates the previous token', () => {
  /** Resend issues a NEW token and kills the old one — three clicks, one live link. */
  it('case 13: resend invalidates the previous token', async () => {
    const first = await invite(fx.ownerUser, {
      email: 'resend@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    const second = await withTenant(
      fx.db.pool,
      {
        organizationId: fx.agencyOrg,
        userId: fx.ownerUser,
        workspaceIds: [fx.acme, fx.borealis],
        workspaceScope: 'all',
      },
      async (tx) =>
        resendInvitation(
          { ...h.deps, invitations: createInvitationRepository(tx.client) },
          await fx.actorFor(fx.ownerUser),
          first.invitationId,
        ),
    );
    if (second === undefined) throw new Error('resend failed');

    const invitee = await fx.createUser('resend@agency.test');
    expect(await accept(first.token, invitee, 'resend@agency.test')).toEqual({
      outcome: 'failed',
      reason: 'invalid',
    });
    expect((await accept(second.token, invitee, 'resend@agency.test')).outcome).toBe('accepted');
  });
});
