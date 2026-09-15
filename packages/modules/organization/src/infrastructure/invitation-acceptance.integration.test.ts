/**
 * Accepting invitations — the paths that GRANT access.
 *
 * A redemption that succeeds must produce a real membership, a real role assignment and a
 * real accessible-workspace set, in exactly one organization. Asserted through
 * `resolveActorContext`, so what is checked is the access the accepter actually ends up
 * with rather than the rows that were written.
 */

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
import { revokeInvitation } from '../application/index.js';
import { resolveActorContext } from './actor-resolver.js';
import { createInvitationRepository } from './invitation-repository.js';
import { addMember } from './provisioning.js';

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

describe('cases 10-11 — acceptance creates real membership and access', () => {
  it('case 11: a new user joins with the invited role and workspace', async () => {
    const created = await invite(fx.ownerUser, {
      email: 'new@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    const invitee = await fx.createUser('new@agency.test');

    const result = await accept(created.token, invitee, 'new@agency.test');
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.organizationId).toBe(fx.agencyOrg);

    // The access is real: resolved through the production path.
    const ctx = await fx.actorFor(invitee);
    expect(ctx.accessibleWorkspaceIds).toEqual([fx.acme]);
  });

  it('case 10: an existing user of another organization can also accept', async () => {
    const rivalMember = await fx.createUser('crossover@rival.test');
    await withTenant(
      fx.db.pool,
      { organizationId: fx.rivalOrg, userId: rivalMember, workspaceIds: [], workspaceScope: 'all' },
      async (tx) => {
        await addMember(tx.client, { organizationId: fx.rivalOrg, userId: rivalMember });
      },
    );

    const created = await invite(fx.ownerUser, {
      email: 'crossover@rival.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    const result = await accept(created.token, rivalMember, 'crossover@rival.test');
    expect(result.outcome).toBe('accepted');

    // Membership in two organizations, with access in each kept separate.
    const agencyCtx = await fx.actorFor(rivalMember, fx.agencyOrg);
    expect(agencyCtx.accessibleWorkspaceIds).toEqual([fx.acme]);
  });

  it('refuses when the accepter is already a member', async () => {
    const created = await invite(fx.ownerUser, {
      email: 'admin@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    expect(await accept(created.token, fx.adminUser, 'admin@agency.test')).toEqual({
      outcome: 'failed',
      reason: 'already_a_member',
    });
  });
});

describe('case 9 — client_guest invitations', () => {
  it('creates a CLIENT membership confined to one workspace', async () => {
    const created = await invite(fx.ownerUser, {
      email: 'reviewer@client.test',
      roleSlug: 'client_guest',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    const guest = await fx.createUser('reviewer@client.test');
    expect((await accept(created.token, guest, 'reviewer@client.test')).outcome).toBe('accepted');

    const member = await fx.admin.query<{ member_type: string }>(
      'SELECT member_type FROM organization_members WHERE user_id = $1',
      [guest],
    );
    expect(member.rows[0]?.member_type).toBe('client');

    const ctx = await fx.actorFor(guest);
    // Confined to the invited workspace, and nothing else in the agency.
    expect(ctx.accessibleWorkspaceIds).toEqual([fx.acme]);
    expect(ctx.workspaceScope).toBe('set');
  });
});

describe('case 15 — cross-tenant', () => {
  it("an inviter cannot revoke another organization's invitation", async () => {
    const created = await invite(fx.ownerUser, {
      email: 'target@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    // An actor holding the agency's permissions but acting in the rival's tenant context —
    // the shape a confused-deputy bug would take. Both defences refuse independently: the
    // repository's own `organization_id = $1`, and the RLS policy on the connection.
    const rivalCtx = { ...(await fx.actorFor(fx.ownerUser)), organizationId: fx.rivalOrg };
    const revoked = await withTenant(
      fx.db.pool,
      { organizationId: fx.rivalOrg, userId: fx.ownerUser, workspaceIds: [] },
      async (tx) =>
        await revokeInvitation(
          { ...h.deps, invitations: createInvitationRepository(tx.client) },
          rivalCtx,
          created.invitationId,
        ),
    );
    expect(revoked).toBe(false);

    // And the invitation is untouched, not merely "not reported as revoked".
    const row = await fx.admin.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM invitations WHERE id = $1',
      [created.invitationId],
    );
    expect(row.rows[0]?.revoked_at).toBeNull();
  });

  it("an invitation never grants access to the inviter's other organizations", async () => {
    const created = await invite(fx.ownerUser, {
      email: 'single@agency.test',
      roleSlug: 'editor',
      scope: { kind: 'workspace', workspaceId: fx.acme },
    });
    const invitee = await fx.createUser('single@agency.test');
    await accept(created.token, invitee, 'single@agency.test');

    expect(
      await resolveActorContext(fx.db.pool, {
        userId: invitee,
        organizationId: fx.rivalOrg,
        mfaSatisfied: true,
      }),
    ).toBeUndefined();
  });
});
