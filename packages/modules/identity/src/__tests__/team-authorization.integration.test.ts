/**
 * AUTHENTICATION MUST NEVER BYPASS AUTHORIZATION — the TEAM path.
 *
 * Its sibling suite (`authorization.integration.test.ts`) covers actors whose workspace
 * access is a role row they hold directly. This one covers the case the three-level tenancy
 * model exists for, and it is materially different:
 *
 *   Teams are deliberately ABSENT from the RLS predicate (05 §3, 06 §3). A team member holds
 *   no workspace-scoped role at all. Their accessible set is COMPUTED in the application
 *   layer by expanding team → workspaces-owned and team → workspaces-granted, and the
 *   resulting set is then handed to the database as `app.workspace_ids`.
 *
 * So every other authenticated actor is authorised by a row that either exists or does not.
 * This one is authorised by a derivation — and a derivation can be wrong in ways a lookup
 * cannot: it can over-include (a set wider than the team's reach, which the database would
 * then faithfully honour), or it can go stale (access surviving a removal, because the set
 * was computed once and the row it came from is gone).
 *
 * Both failure modes are asserted here, from a genuinely authenticated session.
 */
import { decide } from '@growth-os/authz';
import { withTenant } from '@growth-os/db';
import {
  addMember,
  addTeamMember,
  assignRole,
  createTeam,
  createWorkspace,
  grantTeamWorkspaceAccess,
  provisionOrganization,
  resolveActorContext,
} from '@growth-os/module-organization/infrastructure';
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from '@growth-os/testing';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIdentity, type IdentityHarness } from '../__testing__/harness.js';
import { authenticateSession, register, signIn, verifyEmail } from '../application/index.js';

let db: TestDatabase;
let h: IdentityHarness;

const PASSWORD = 'correct horse battery staple';

let agencyOrg: string;
let podA: string;
let podB: string;
/** Owned by pod A. */
let acme: string;
/** Owned by pod B, and later GRANTED to pod A — the specialist-pod case. */
let borealis: string;
/** Owned by pod B and never shared. The workspace pod A must never reach. */
let cascade: string;

let principalId: string;
let podAMemberId: string;

const podder = { email: 'podder@agency.test', userId: '' };
const outsider = { email: 'outsider@agency.test', userId: '' };

async function realUser(email: string): Promise<string> {
  const { userId, verificationToken } = await register(h, { email, password: PASSWORD });
  await verifyEmail(h, verificationToken);
  return userId;
}

async function realSignIn(email: string): Promise<string> {
  const result = await signIn(h, { email, password: PASSWORD });
  if (result.outcome !== 'authenticated') throw new Error(`expected auth, got ${result.outcome}`);
  return result.token;
}

async function asOwner<T>(body: (c: PoolClient) => Promise<T>): Promise<T> {
  const ctx = await resolveActorContext(db.pool, {
    userId: principalId,
    organizationId: agencyOrg,
    mfaSatisfied: true,
  });
  if (ctx === undefined) throw new Error('owner did not resolve');
  return await withTenant(
    db.pool,
    {
      organizationId: agencyOrg,
      userId: principalId,
      workspaceIds: ctx.accessibleWorkspaceIds,
      workspaceScope: ctx.workspaceScope,
    },
    async (tx) => await body(tx.client),
  );
}

/**
 * Authenticates for real, then resolves the actor context.
 *
 * Both halves, every time. Resolving a context without first proving the session would be
 * testing the organization module, not the claim this file is about.
 */
async function signInAndResolve(email: string, userId: string) {
  const lookup = await authenticateSession(h, await realSignIn(email));
  expect(lookup.ok).toBe(true);
  expect(lookup.ok && lookup.value.user.id).toBe(userId);
  return await resolveActorContext(db.pool, {
    userId,
    organizationId: agencyOrg,
    mfaSatisfied: true,
  });
}

beforeAll(async () => {
  db = await acquireTestDatabase();
  h = buildIdentity(db.pool);

  podder.userId = await realUser(podder.email);
  outsider.userId = await realUser(outsider.email);
  principalId = await realUser('principal@agency.test');

  const agency = await provisionOrganization(db.pool, {
    name: 'Northwind',
    slug: 'northwind',
    kind: 'agency',
    ownerUserId: principalId,
  });
  agencyOrg = agency.organizationId;

  await asOwner(async (c) => {
    podA = await createTeam(c, agencyOrg, 'pod-a', 'Pod A');
    podB = await createTeam(c, agencyOrg, 'pod-b', 'Pod B');

    acme = await createWorkspace(c, {
      organizationId: agencyOrg,
      teamId: podA,
      slug: 'acme',
      name: 'Acme',
    });
    borealis = await createWorkspace(c, {
      organizationId: agencyOrg,
      teamId: podB,
      slug: 'borealis',
      name: 'Borealis',
    });
    cascade = await createWorkspace(c, {
      organizationId: agencyOrg,
      teamId: podB,
      slug: 'cascade',
      name: 'Cascade',
    });

    // Pod A is lent Borealis. Cascade, also pod B's, is deliberately not.
    await grantTeamWorkspaceAccess(c, agencyOrg, podA, borealis);

    // THE ACTOR UNDER TEST. A member of the organization and of pod A, carrying a TEAM-scoped
    // role and NO workspace-scoped role whatsoever. Every workspace they reach is derived.
    const member = await addMember(c, { organizationId: agencyOrg, userId: podder.userId });
    podAMemberId = member;
    await addTeamMember(c, agencyOrg, podA, member, 'team_member');
    await assignRole(c, {
      organizationId: agencyOrg,
      memberId: member,
      roleSlug: 'team_member',
      teamId: podA,
    });

    // A member of the organization and of NO team, to show membership alone derives nothing.
    const lone = await addMember(c, { organizationId: agencyOrg, userId: outsider.userId });
    await assignRole(c, { organizationId: agencyOrg, memberId: lone, roleSlug: 'member' });
  });
}, 180_000);

afterAll(async () => {
  await db.close();
  await stopSharedCluster();
});

describe('a team member reaches exactly what their team reaches', () => {
  it('derives the workspaces the team OWNS and those GRANTED to it, and no others', async () => {
    const ctx = await signInAndResolve(podder.email, podder.userId);
    expect(ctx).toBeDefined();
    if (ctx === undefined) return;

    expect([...ctx.accessibleWorkspaceIds].sort()).toEqual([acme, borealis].sort());
    expect(ctx.accessibleWorkspaceIds).not.toContain(cascade);
    // Derived, not organization-wide. 'all' here would hand the database every workspace.
    expect(ctx.workspaceScope).toBe('set');
    expect(ctx.teamIds).toEqual([podA]);
  });

  it('may do the work in a workspace its team owns', async () => {
    const ctx = await signInAndResolve(podder.email, podder.userId);
    if (ctx === undefined) throw new Error('setup');
    expect(
      decide(ctx, 'social.post:create', { type: 'post', id: acme, workspaceId: acme }).allowed,
    ).toBe(true);
  });

  it('may do the work in a workspace merely LENT to its team', async () => {
    const ctx = await signInAndResolve(podder.email, podder.userId);
    if (ctx === undefined) throw new Error('setup');
    expect(
      decide(ctx, 'social.post:create', { type: 'post', id: borealis, workspaceId: borealis })
        .allowed,
    ).toBe(true);
  });

  /** The over-inclusion failure. A derived set that is too wide is honoured by the database. */
  it('is DENIED a sibling workspace of the same organization that its team cannot reach', async () => {
    const ctx = await signInAndResolve(podder.email, podder.userId);
    if (ctx === undefined) throw new Error('setup');
    const decision = decide(ctx, 'social.post:create', {
      type: 'post',
      id: cascade,
      workspaceId: cascade,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('workspace_not_accessible');
  });

  /**
   * And the database agrees, independently. The engine's answer and the policy's answer are
   * two mechanisms; a suite that only asked the engine would pass with RLS switched off.
   */
  it('cannot read that sibling workspace at the DATABASE either', async () => {
    const ctx = await signInAndResolve(podder.email, podder.userId);
    if (ctx === undefined) throw new Error('setup');

    const rows = await withTenant(
      db.pool,
      {
        organizationId: agencyOrg,
        userId: podder.userId,
        workspaceIds: ctx.accessibleWorkspaceIds,
        workspaceScope: ctx.workspaceScope,
      },
      async (tx) => {
        const seen = await tx.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
        return seen.rows.map((r) => r.id);
      },
    );
    expect(rows.sort()).toEqual([acme, borealis].sort());
    expect(rows).not.toContain(cascade);
  });

  it('is denied organization administration, holding only a team-scoped role', async () => {
    const ctx = await signInAndResolve(podder.email, podder.userId);
    if (ctx === undefined) throw new Error('setup');
    expect(decide(ctx, 'organization.member:invite').allowed).toBe(false);
    expect(decide(ctx, 'organization.api_key:create').allowed).toBe(false);
  });
});

describe('organization membership alone derives nothing', () => {
  /**
   * The member role is organization-scoped, which is exactly the shape that once handed a
   * plain member every workspace in the tenant. It grants `organization:read` and nothing
   * workspace-scoped, so the derived set must be EMPTY.
   */
  it('a member of no team reaches no workspace at all', async () => {
    const ctx = await signInAndResolve(outsider.email, outsider.userId);
    expect(ctx).toBeDefined();
    if (ctx === undefined) return;

    expect(ctx.accessibleWorkspaceIds).toEqual([]);
    expect(ctx.workspaceScope).toBe('set');
    expect(
      decide(ctx, 'social.post:create', { type: 'post', id: acme, workspaceId: acme }).allowed,
    ).toBe(false);
  });

  it('and sees zero workspaces at the database', async () => {
    const ctx = await signInAndResolve(outsider.email, outsider.userId);
    if (ctx === undefined) throw new Error('setup');
    const count = await withTenant(
      db.pool,
      {
        organizationId: agencyOrg,
        userId: outsider.userId,
        workspaceIds: ctx.accessibleWorkspaceIds,
        workspaceScope: ctx.workspaceScope,
      },
      async (tx) => (await tx.query('SELECT 1 FROM workspaces')).rowCount,
    );
    expect(count).toBe(0);
  });
});

describe('the derivation is re-run, never remembered', () => {
  /**
   * THE STALENESS FAILURE. The accessible set is computed per resolution; if it were cached
   * against the session, revoking a team membership would leave a signed-in user holding
   * access to a client they have been taken off — the exact scenario an agency removes
   * someone for.
   *
   * The session deliberately stays valid throughout: this asserts that authorization is
   * re-derived, not that authentication was revoked.
   */
  it('loses a lent workspace the moment the grant is withdrawn, on the same session', async () => {
    const token = await realSignIn(podder.email);
    expect((await authenticateSession(h, token)).ok).toBe(true);

    const before = await resolveActorContext(db.pool, {
      userId: podder.userId,
      organizationId: agencyOrg,
      mfaSatisfied: true,
    });
    expect(before?.accessibleWorkspaceIds).toContain(borealis);

    await asOwner(async (c) => {
      await c.query('DELETE FROM team_workspace_access WHERE team_id = $1 AND workspace_id = $2', [
        podA,
        borealis,
      ]);
    });

    // Same session, still authenticated — and now reaching one workspace fewer.
    expect((await authenticateSession(h, token)).ok).toBe(true);
    const after = await resolveActorContext(db.pool, {
      userId: podder.userId,
      organizationId: agencyOrg,
      mfaSatisfied: true,
    });
    expect(after?.accessibleWorkspaceIds).toEqual([acme]);
    expect(
      after !== undefined &&
        decide(after, 'social.post:create', { type: 'post', id: borealis, workspaceId: borealis })
          .allowed,
    ).toBe(false);
  });

  it('loses every workspace when the team membership itself is removed', async () => {
    const token = await realSignIn(podder.email);

    await asOwner(async (c) => {
      await c.query('DELETE FROM team_members WHERE team_id = $1 AND organization_member_id = $2', [
        podA,
        podAMemberId,
      ]);
    });

    // Still signed in. Still a member of the organization. Reaching nothing.
    expect((await authenticateSession(h, token)).ok).toBe(true);
    const after = await resolveActorContext(db.pool, {
      userId: podder.userId,
      organizationId: agencyOrg,
      mfaSatisfied: true,
    });
    expect(after).toBeDefined();
    expect(after?.accessibleWorkspaceIds).toEqual([]);
    expect(after?.teamIds).toEqual([]);
  });
});
