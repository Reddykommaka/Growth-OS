/**
 * THE PHASE 1 EXIT CRITERION, part 1 (14-roadmap.md):
 *
 *   "an agency E2E (two pods, four clients, a client guest) passes"
 *
 * This half covers staff access: who reaches which client, how that follows team structure,
 * and what happens when staffing changes. The client-guest half is in agency-guest.test.ts.
 *
 * Every claim is made twice where it matters: once against the authorization engine (what
 * the actor may DO) and once against the database through the tenant-scoped unit of work
 * (what the actor can SEE). A system where those disagree either leaks rows the engine
 * denies, or breaks features the engine permits.
 */
import { decide, type Permission } from '@growth-os/authz';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  asPrincipal,
  clients,
  db,
  members,
  orgId,
  podAId,
  podBId,
  setupAgency,
  teardownAgency,
  users,
  visibleContent,
  visibleWorkspaces,
} from './__testing__/agency-fixture.js';
import { resolveActorContext } from './actor-resolver.js';
import { createWorkspace, grantTeamWorkspaceAccess } from './provisioning.js';

beforeAll(setupAgency, 180_000);
afterAll(teardownAgency);

describe('the agency principal', () => {
  it('sees every client, because an organization-scoped role spans the tenant', async () => {
    expect(await visibleWorkspaces(users.principal)).toEqual([
      'acme',
      'borealis',
      'cygnus',
      'delta',
    ]);
  });
});

describe('a pod lead', () => {
  it('sees only the clients their pod serves', async () => {
    expect(await visibleWorkspaces(users.podALead)).toEqual(['acme', 'borealis']);
    expect(await visibleWorkspaces(users.podBLead)).toEqual(['cygnus', 'delta']);
  });

  it('may do the work in their own pod and not in the other', async () => {
    const ctx = await resolveActorContext(db.pool, {
      userId: users.podALead,
      organizationId: orgId,
      mfaSatisfied: true,
    });
    if (ctx === undefined) throw new Error('unresolved');
    const p: Permission = 'social.post:publish';
    expect(
      decide(ctx, p, { type: 'post', id: '1', workspaceId: clients['acme'] as string }).allowed,
    ).toBe(true);
    expect(
      decide(ctx, p, { type: 'post', id: '2', workspaceId: clients['cygnus'] as string }).allowed,
    ).toBe(false);
  });

  /**
   * The property that makes agency access maintainable: onboarding a client is ONE write,
   * and everyone already in the pod can reach it. No per-person grant, and nothing to
   * remember to revoke on the way out.
   */
  it('reaches a client added to their pod afterwards, with no new grant', async () => {
    expect(await visibleWorkspaces(users.podAStaff)).toEqual(['acme', 'borealis']);

    await asPrincipal(async (c) => {
      clients['echo'] = await createWorkspace(c, {
        organizationId: orgId,
        teamId: podAId(),
        slug: 'echo',
        name: 'Echo',
      });
    });

    expect(await visibleWorkspaces(users.podAStaff)).toEqual(['acme', 'borealis', 'echo']);
  });
});

describe("a specialist pod granted access to another pod's client", () => {
  it('reaches exactly that client and no other', async () => {
    await asPrincipal(async (c) => {
      await grantTeamWorkspaceAccess(c, orgId, podBId(), clients['acme'] as string, 'contributor');
    });

    // Pod B now reaches Acme through the grant, while still not reaching Borealis or Echo.
    expect(await visibleWorkspaces(users.podBLead)).toEqual(['acme', 'cygnus', 'delta']);
  });
});

describe("level 3 in force — a pod reads only its own clients' work", () => {
  it('pod A sees pod A content, pod B sees pod B content', async () => {
    const podA = await visibleContent(users.podALead);
    expect(podA).toContain('acme-post');
    expect(podA).toContain('borealis-post');
    expect(podA).not.toContain('cygnus-post');

    const podB = await visibleContent(users.podBLead);
    expect(podB).toContain('cygnus-post');
    expect(podB).toContain('delta-post');
    expect(podB).not.toContain('borealis-post');
  });

  it("the principal sees every client's work", async () => {
    const all = await visibleContent(users.principal);
    expect(all).toContain('acme-post');
    expect(all).toContain('delta-post');
  });
});

describe('someone outside the organization', () => {
  it('resolves to no actor context at all', async () => {
    const ctx = await resolveActorContext(db.pool, {
      userId: users.outsider,
      organizationId: orgId,
      mfaSatisfied: true,
    });
    expect(ctx).toBeUndefined();
  });
});

describe('removing a member takes effect on the next request', () => {
  it('a pod member removed from the pod loses every client that pod served', async () => {
    expect(await visibleWorkspaces(users.podAStaff)).not.toEqual([]);

    await admin.query('DELETE FROM team_members WHERE organization_member_id = $1', [
      members['podAStaff'],
    ]);

    // Nothing to invalidate on this path: the resolver recomputes, and the set it produces
    // is what the database enforces. Membership removal is immediate by construction —
    // which is the behaviour 06 §5 requires of it.
    expect(await visibleWorkspaces(users.podAStaff)).toEqual([]);
  });
});
