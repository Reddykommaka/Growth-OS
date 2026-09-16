/**
 * Invitations under CONCURRENCY, and the abuse limits that bound them.
 *
 * Every outcome here is settled by the DATABASE — a conditional `UPDATE` whose predicate
 * names the state the caller believed it was acting on — rather than by a check in
 * application code. That distinction is the whole point: a read-then-write looks correct in
 * review, passes every sequential test, and loses exactly one of two simultaneous operators.
 *
 * The resend races below are the reason `rotateToken` is a compare-and-set. Before it was,
 * all three of them corrupted the invitation in a different way.
 */

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
import { acceptInvitation } from '../application/index.js';

let fx: AgencyFixture;
let h: InvitationHarness;
const recorder = createRecorder();

const invite: InvitationHarness['invite'] = (...a) => h.invite(...a);
const accept: InvitationHarness['accept'] = (...a) => h.accept(...a);

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

async function pending(email: string) {
  return await invite(fx.ownerUser, {
    email,
    roleSlug: 'editor',
    scope: { kind: 'workspace', workspaceId: fx.acme },
  });
}

/** The row as the database actually holds it, read past RLS so nothing is hidden. */
async function row(invitationId: string) {
  const r = await fx.admin.query<{
    token_hash: Buffer;
    accepted_at: Date | null;
    revoked_at: Date | null;
    expires_at: Date;
  }>('SELECT token_hash, accepted_at, revoked_at, expires_at FROM invitations WHERE id = $1', [
    invitationId,
  ]);
  return r.rows[0];
}

describe('two operators resending at the same time', () => {
  /**
   * Both callers mint a token and both write. With a blind `UPDATE` both succeeded, the last
   * writer's hash survived, and BOTH operators were handed a token they believed was live —
   * so one invitee received a link that was dead before it was sent, and nobody could tell
   * which.
   */
  it('exactly one resend wins, and the loser is told rather than handed a dead token', async () => {
    const created = await pending('race@agency.test');

    const results = await h.raceResends(fx.ownerUser, created.invitationId);

    const winners = results.filter((r) => r !== undefined);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);

    // And the token the winner was given is the one the row actually carries.
    const invitee = await fx.createUser('race@agency.test');
    expect((await accept(winners[0]?.token ?? '', invitee, 'race@agency.test')).outcome).toBe(
      'accepted',
    );
  });

  it('mails exactly one link, not two', async () => {
    const created = await pending('race2@agency.test');
    h.delivered.length = 0;

    await h.raceResends(fx.ownerUser, created.invitationId);

    // The loser returns before notifying, so no dead link is ever put in front of a person.
    expect(h.delivered.filter((d) => d.resent)).toHaveLength(1);
  });

  it('the original token is dead either way', async () => {
    const created = await pending('race3@agency.test');
    await h.raceResends(fx.ownerUser, created.invitationId);
    const invitee = await fx.createUser('race3@agency.test');
    expect(await accept(created.token, invitee, 'race3@agency.test')).toEqual({
      outcome: 'failed',
      reason: 'invalid',
    });
  });
});

describe('a resend racing an acceptance', () => {
  /**
   * The pending check is a READ. An acceptance landing between it and the write used to mint
   * a fresh token for an invitation that had already been consumed — a link that can never
   * work, sent to someone who had already joined.
   */
  it('does not mint a token for an invitation that was accepted first', async () => {
    const created = await pending('both@agency.test');
    const invitee = await fx.createUser('both@agency.test');

    const [accepted, resent] = await Promise.all([
      accept(created.token, invitee, 'both@agency.test'),
      h.resend(fx.ownerUser, created.invitationId),
    ]);

    if (accepted.outcome === 'accepted') {
      // Acceptance won: the resend must have been refused, and the row stays consumed.
      expect(resent).toBeUndefined();
      expect((await row(created.invitationId))?.accepted_at).not.toBeNull();
    } else {
      // The resend won: acceptance then failed against the rotated token, and a NEW token
      // exists that still works.
      expect(resent).toBeDefined();
      expect(accepted.outcome).toBe('failed');
      const second = await accept(resent?.token ?? '', invitee, 'both@agency.test');
      expect(second.outcome).toBe('accepted');
    }
  });

  it('never leaves an accepted invitation carrying a freshly-minted live token', async () => {
    const created = await pending('consumed@agency.test');
    const invitee = await fx.createUser('consumed@agency.test');
    expect((await accept(created.token, invitee, 'consumed@agency.test')).outcome).toBe('accepted');

    const before = await row(created.invitationId);
    expect(await h.resend(fx.ownerUser, created.invitationId)).toBeUndefined();
    const after = await row(created.invitationId);

    // Byte-identical: the consumed row was not touched at all.
    expect(after?.token_hash.equals(before?.token_hash ?? Buffer.alloc(0))).toBe(true);
    expect(after?.expires_at.getTime()).toBe(before?.expires_at.getTime());
  });
});

describe('a resend racing a revocation', () => {
  /**
   * THE SECURITY-RELEVANT ONE. A blind write gave a REVOKED invitation a live token hash and
   * a fresh expiry — a revocation that did not fully take, on a row an operator had already
   * been told was dead.
   */
  it('cannot resurrect a revoked invitation with a fresh token and expiry', async () => {
    const created = await pending('revoked@agency.test');
    expect(await h.revoke(fx.ownerUser, created.invitationId)).toBe(true);

    const before = await row(created.invitationId);
    expect(before?.revoked_at).not.toBeNull();

    expect(await h.resend(fx.ownerUser, created.invitationId)).toBeUndefined();

    const after = await row(created.invitationId);
    expect(after?.revoked_at?.getTime()).toBe(before?.revoked_at?.getTime());
    expect(after?.token_hash.equals(before?.token_hash ?? Buffer.alloc(0))).toBe(true);
    expect(after?.expires_at.getTime()).toBe(before?.expires_at.getTime());
  });

  /**
   * A revoke and a resend launched together, with no barrier — so BOTH orderings occur
   * across runs, which is the point. Either is legitimate on its own:
   *
   *   - revoke lands first, and the resend is refused;
   *   - the resend lands first, and the revoke then revokes the refreshed invitation.
   *
   * What must never happen is the state in between: a row marked revoked that still carries
   * a token somebody can redeem. So the assertion is on the END STATE, not on which call
   * returned what — an earlier version of this test asserted "not both succeed" and was
   * flaky precisely because both succeeding is fine when the resend goes first.
   */
  /**
   * The two orderings, pinned deterministically, so neither branch of the concurrent test
   * below can quietly stop being exercised. Revoke-then-resend is covered above; this is the
   * other way round, which must still end with nothing redeemable.
   */
  it('resend then revoke: the refreshed token is revoked too', async () => {
    const created = await pending('order@agency.test');
    const resent = await h.resend(fx.ownerUser, created.invitationId);
    expect(resent).toBeDefined();

    expect(await h.revoke(fx.ownerUser, created.invitationId)).toBe(true);

    const invitee = await fx.createUser('order@agency.test');
    for (const token of [created.token, resent?.token ?? '']) {
      expect((await accept(token, invitee, 'order@agency.test')).outcome).toBe('failed');
    }
    expect(
      (await fx.admin.query('SELECT 1 FROM organization_members WHERE user_id = $1', [invitee]))
        .rowCount,
    ).toBe(0);
  });

  it('leaves no redeemable token behind whichever of the two lands first', async () => {
    const created = await pending('simul@agency.test');

    const [revoked, resent] = await Promise.all([
      h.revoke(fx.ownerUser, created.invitationId),
      h.resend(fx.ownerUser, created.invitationId),
    ]);

    const invitee = await fx.createUser('simul@agency.test');
    const state = await row(created.invitationId);

    if (state?.revoked_at != null) {
      // Revoked: EVERY token ever issued for this invitation is dead, the fresh one included.
      for (const token of [created.token, resent?.token].filter((t) => t !== undefined)) {
        expect((await accept(token, invitee, 'simul@agency.test')).outcome).toBe('failed');
      }
      expect(
        (await fx.admin.query('SELECT 1 FROM organization_members WHERE user_id = $1', [invitee]))
          .rowCount,
      ).toBe(0);
    } else {
      // Not revoked, so the resend must have won and its token must be the live one.
      expect(revoked).toBe(false);
      expect(resent).toBeDefined();
      expect((await accept(resent?.token ?? '', invitee, 'simul@agency.test')).outcome).toBe(
        'accepted',
      );
    }
  });

  it('two simultaneous revocations report one winner and leave one revocation time', async () => {
    const created = await pending('double@agency.test');
    const results = await Promise.all([
      h.revoke(fx.ownerUser, created.invitationId),
      h.revoke(fx.ownerUser, created.invitationId),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await row(created.invitationId))?.revoked_at).not.toBeNull();
  });
});

describe('abuse limits', () => {
  /**
   * Bounded per ORGANIZATION, not per user: an attacker with one compromised account would
   * otherwise mail the whole address book from a domain the recipients already trust.
   */
  it('refuses to create beyond the limit, and writes nothing when it does', async () => {
    let consumed = 0;
    const keys: string[] = [];
    const rateLimiter = {
      consume: async (key: string) => {
        keys.push(key);
        consumed += 1;
        return consumed <= 1;
      },
      reset: async () => undefined,
    };
    const input = {
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    } as const;

    await h.inviteUsing(fx.ownerUser, { ...input, email: 'first@agency.test' }, { rateLimiter });
    await expect(
      h.inviteUsing(fx.ownerUser, { ...input, email: 'second@agency.test' }, { rateLimiter }),
    ).rejects.toThrow(/too many invitations/i);

    expect((await fx.admin.query('SELECT 1 FROM invitations')).rowCount).toBe(1);
    // Keyed by the organization, so one compromised account cannot spend another tenant's
    // budget — nor escape its own by switching user.
    expect(keys.every((k) => k === `invite:${fx.agencyOrg}`)).toBe(true);
  });

  /**
   * Acceptance is limited too, and keyed by the organization the TOKEN names — so grinding
   * tokens against one tenant is bounded even when the presenter moves between addresses.
   */
  it('refuses acceptance beyond the limit, without reading the invitation at all', async () => {
    const created = await pending('limited@agency.test');
    const invitee = await fx.createUser('limited@agency.test');

    let consumed = 0;
    const keys: string[] = [];
    const limited = {
      ...h.acceptDeps,
      rateLimiter: {
        consume: async (key: string) => {
          keys.push(key);
          consumed += 1;
          return consumed <= 1;
        },
        reset: async () => undefined,
      },
    };

    expect(
      (
        await acceptInvitation(limited, {
          token: created.token,
          userId: invitee,
          userEmail: 'limited@agency.test',
        })
      ).outcome,
    ).toBe('accepted');

    expect(
      await acceptInvitation(limited, {
        token: created.token,
        userId: invitee,
        userEmail: 'limited@agency.test',
      }),
    ).toEqual({ outcome: 'failed', reason: 'rate_limited' });

    expect(keys).toEqual([`accept:${fx.agencyOrg}`, `accept:${fx.agencyOrg}`]);
  });

  it('a malformed token is refused before the limiter is ever consulted', async () => {
    let consumed = 0;
    const limited = {
      ...h.acceptDeps,
      rateLimiter: {
        consume: async () => {
          consumed += 1;
          return true;
        },
        reset: async () => undefined,
      },
    };
    const stranger = await fx.createUser('nobody@agency.test');
    expect(
      await acceptInvitation(limited, {
        token: 'not-a-token',
        userId: stranger,
        userEmail: 'nobody@agency.test',
      }),
    ).toEqual({ outcome: 'failed', reason: 'invalid' });
    // Garbage must not be able to exhaust a real tenant's acceptance budget.
    expect(consumed).toBe(0);
  });
});
