/**
 * AUTHENTICATION MUST NEVER BYPASS AUTHORIZATION.
 *
 * Every test here starts from a genuinely authenticated session — a real password, a real
 * Argon2 verification, a real session row — and then asserts that being signed in buys
 * nothing on its own. Membership, role, permission, workspace access, client_guest
 * containment and RLS are each checked independently, against a real cluster.
 *
 * This is the suite that would fail if someone "simplified" sign-in by trusting the session
 * for authorization, which is the single most common way a system like this is got wrong.
 *
 * It lives outside application/ deliberately: it spans identity, organization, authz and the
 * database, so it is not a test OF the application layer and must not be bound by that
 * layer's import rules — which is what the linter pointed out when it sat there.
 */
import { decide } from '@growth-os/authz';
import { withTenant } from '@growth-os/db';
import {
  addMember,
  assignRole,
  createTeam,
  createWorkspace,
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
let rivalOrg: string;
let podA: string;
let acme: string;
let borealis: string;

const staff = { email: 'staff@agency.test', userId: '' };
const guest = { email: 'reviewer@client.test', userId: '' };
const stranger = { email: 'stranger@elsewhere.test', userId: '' };

/** Registers, verifies and returns the user id — a real account, not a fixture row. */
async function realUser(email: string): Promise<string> {
  const { userId, verificationToken } = await register(h, { email, password: PASSWORD });
  await verifyEmail(h, verificationToken);
  return userId;
}

/** Signs in for real and returns the authenticated session token. */
async function realSignIn(email: string): Promise<string> {
  const result = await signIn(h, { email, password: PASSWORD });
  if (result.outcome !== 'authenticated') throw new Error(`expected auth, got ${result.outcome}`);
  return result.token;
}

async function asOwner<T>(
  organizationId: string,
  ownerUserId: string,
  body: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const ctx = await resolveActorContext(db.pool, {
    userId: ownerUserId,
    organizationId,
    mfaSatisfied: true,
  });
  if (ctx === undefined) throw new Error('owner did not resolve');
  return await withTenant(
    db.pool,
    {
      organizationId,
      userId: ownerUserId,
      workspaceIds: ctx.accessibleWorkspaceIds,
      workspaceScope: ctx.workspaceScope,
    },
    async (tx) => await body(tx.client),
  );
}

beforeAll(async () => {
  db = await acquireTestDatabase();
  h = buildIdentity(db.pool);

  staff.userId = await realUser(staff.email);
  guest.userId = await realUser(guest.email);
  stranger.userId = await realUser(stranger.email);
  const principalId = await realUser('principal@agency.test');
  const rivalOwnerId = await realUser('owner@rival.test');

  const agency = await provisionOrganization(db.pool, {
    name: 'Northwind',
    slug: 'northwind',
    kind: 'agency',
    ownerUserId: principalId,
  });
  agencyOrg = agency.organizationId;

  const rival = await provisionOrganization(db.pool, {
    name: 'Rival',
    slug: 'rival',
    kind: 'agency',
    ownerUserId: rivalOwnerId,
  });
  rivalOrg = rival.organizationId;

  await asOwner(agencyOrg, principalId, async (c) => {
    podA = await createTeam(c, agencyOrg, 'pod-a', 'Pod A');
    acme = await createWorkspace(c, {
      organizationId: agencyOrg,
      teamId: podA,
      slug: 'acme',
      name: 'Acme',
    });
    borealis = await createWorkspace(c, {
      organizationId: agencyOrg,
      teamId: podA,
      slug: 'borealis',
      name: 'Borealis',
    });

    const staffMember = await addMember(c, { organizationId: agencyOrg, userId: staff.userId });
    // Workspace-scoped editor on ACME ONLY. Not a member of pod A, not org-scoped.
    await assignRole(c, {
      organizationId: agencyOrg,
      memberId: staffMember,
      roleSlug: 'editor',
      workspaceId: acme,
    });

    const guestMember = await addMember(c, {
      organizationId: agencyOrg,
      userId: guest.userId,
      memberType: 'client',
    });
    await assignRole(c, {
      organizationId: agencyOrg,
      memberId: guestMember,
      roleSlug: 'client_guest',
      workspaceId: acme,
    });
  });
}, 180_000);

afterAll(async () => {
  await db.close();
  await stopSharedCluster();
});

describe('a valid session proves identity and nothing else', () => {
  it('authenticates the stranger successfully', async () => {
    const lookup = await authenticateSession(h, await realSignIn(stranger.email));
    expect(lookup.ok).toBe(true);
    expect(lookup.ok && lookup.value.user.id).toBe(stranger.userId);
  });

  /**
   * The central claim. A fully authenticated user who is not a member resolves to NO actor
   * context at all — there is no tenant they are acting in, so there is nothing to authorise.
   */
  it('gives the stranger no actor context in an organization they do not belong to', async () => {
    const lookup = await authenticateSession(h, await realSignIn(stranger.email));
    expect(lookup.ok).toBe(true);

    expect(
      await resolveActorContext(db.pool, {
        userId: stranger.userId,
        organizationId: agencyOrg,
        mfaSatisfied: true,
      }),
    ).toBeUndefined();
  });

  it('gives the stranger no context in the rival organization either', async () => {
    expect(
      await resolveActorContext(db.pool, {
        userId: stranger.userId,
        organizationId: rivalOrg,
        mfaSatisfied: true,
      }),
    ).toBeUndefined();
  });

  it('shows the stranger zero rows even if a tenant context is forced open for them', async () => {
    // Belt and braces: even handed an organization id, RLS plus an empty accessible set
    // means nothing is readable. The application check is not the only thing standing here.
    const rows = await withTenant(
      db.pool,
      {
        organizationId: agencyOrg,
        userId: stranger.userId,
        workspaceIds: [],
        workspaceScope: 'set',
      },
      async (tx) => (await tx.query('SELECT slug FROM workspaces')).rows,
    );
    expect(rows).toEqual([]);
  });
});

describe('membership is necessary but not sufficient', () => {
  it('resolves a context for the staff member', async () => {
    const ctx = await resolveActorContext(db.pool, {
      userId: staff.userId,
      organizationId: agencyOrg,
      mfaSatisfied: true,
    });
    expect(ctx).toBeDefined();
    expect(ctx?.organizationMemberId).toBeDefined();
  });

  it('grants only the ONE workspace their role names, not the whole organization', async () => {
    const ctx = await resolveActorContext(db.pool, {
      userId: staff.userId,
      organizationId: agencyOrg,
      mfaSatisfied: true,
    });
    expect(ctx?.accessibleWorkspaceIds).toEqual([acme]);
    expect(ctx?.workspaceScope).toBe('set');
  });

  it('permits the work their role allows, in that workspace', async () => {
    const ctx = await resolveActorContext(db.pool, {
      userId: staff.userId,
      organizationId: agencyOrg,
      mfaSatisfied: true,
    });
    if (ctx === undefined) throw new Error('unresolved');
    expect(
      decide(ctx, 'social.post:create', { type: 'post', id: 'p', workspaceId: acme }).allowed,
    ).toBe(true);
  });

  it('DENIES the same work in a sibling workspace of the same organization', async () => {
    const ctx = await resolveActorContext(db.pool, {
      userId: staff.userId,
      organizationId: agencyOrg,
      mfaSatisfied: true,
    });
    if (ctx === undefined) throw new Error('unresolved');
    const decision = decide(ctx, 'social.post:create', {
      type: 'post',
      id: 'p',
      workspaceId: borealis,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('workspace_not_accessible');
  });

  it('DENIES organization administration to a workspace-scoped editor', async () => {
    const ctx = await resolveActorContext(db.pool, {
      userId: staff.userId,
      organizationId: agencyOrg,
      mfaSatisfied: true,
    });
    if (ctx === undefined) throw new Error('unresolved');
    for (const permission of [
      'organization.member:invite',
      'organization.member:remove',
      'organization.role_assignment:grant',
      'billing.subscription:manage',
      'organization.api_key:create',
    ] as const) {
      expect(decide(ctx, permission).allowed, permission).toBe(false);
    }
  });

  it('cannot read a sibling workspace at the DATABASE either', async () => {
    const ctx = await resolveActorContext(db.pool, {
      userId: staff.userId,
      organizationId: agencyOrg,
      mfaSatisfied: true,
    });
    if (ctx === undefined) throw new Error('unresolved');
    const rows = await withTenant(
      db.pool,
      {
        organizationId: agencyOrg,
        userId: staff.userId,
        workspaceIds: ctx.accessibleWorkspaceIds,
        workspaceScope: ctx.workspaceScope,
      },
      async (tx) =>
        (await tx.query<{ slug: string }>('SELECT slug FROM workspaces ORDER BY slug')).rows,
    );
    expect(rows.map((r) => r.slug)).toEqual(['acme']);
  });
});

describe('client_guest remains contained after authenticating', () => {
  it('signs in like anyone else', async () => {
    const lookup = await authenticateSession(h, await realSignIn(guest.email));
    expect(lookup.ok).toBe(true);
  });

  it('reaches exactly one workspace', async () => {
    const ctx = await resolveActorContext(db.pool, {
      userId: guest.userId,
      organizationId: agencyOrg,
      mfaSatisfied: true,
    });
    expect(ctx?.accessibleWorkspaceIds).toEqual([acme]);
  });

  it('may approve in their own workspace and nothing in another', async () => {
    const ctx = await resolveActorContext(db.pool, {
      userId: guest.userId,
      organizationId: agencyOrg,
      mfaSatisfied: true,
    });
    if (ctx === undefined) throw new Error('unresolved');
    expect(
      decide(ctx, 'social.post:approve', { type: 'post', id: 'p', workspaceId: acme }).allowed,
    ).toBe(true);
    expect(
      decide(ctx, 'social.post:approve', { type: 'post', id: 'p', workspaceId: borealis }).allowed,
    ).toBe(false);
  });

  it("is denied the agency's costs, billing, members and credentials", async () => {
    const ctx = await resolveActorContext(db.pool, {
      userId: guest.userId,
      organizationId: agencyOrg,
      mfaSatisfied: true,
    });
    if (ctx === undefined) throw new Error('unresolved');
    for (const permission of [
      'analytics.cost:read',
      'billing.invoice:read',
      'organization.member:read',
      'integrations.credential:read',
      'organization.api_key:read',
    ] as const) {
      expect(decide(ctx, permission).allowed, permission).toBe(false);
    }
  });
});

describe('cross-tenant isolation survives authentication', () => {
  it('an agency member has no context in the rival organization', async () => {
    expect(
      await resolveActorContext(db.pool, {
        userId: staff.userId,
        organizationId: rivalOrg,
        mfaSatisfied: true,
      }),
    ).toBeUndefined();
  });

  it("cannot read the rival's workspaces even with a forced context and the widest scope", async () => {
    const rows = await withTenant(
      db.pool,
      { organizationId: agencyOrg, userId: staff.userId, workspaceIds: [], workspaceScope: 'all' },
      async (tx) =>
        (await tx.query('SELECT slug FROM workspaces WHERE organization_id = $1', [rivalOrg])).rows,
    );
    expect(rows).toEqual([]);
  });

  it('a session is bound to a user, never to a tenant', async () => {
    const token = await realSignIn(staff.email);
    const lookup = await authenticateSession(h, token);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    // Nothing on the authenticated session names an organization until one is chosen — and
    // choosing one is a separate, authorised step.
    expect(lookup.value.session.activeOrganizationId).toBeNull();
  });
});

describe('an unsatisfied second factor does not become authorization', () => {
  it('a session awaiting MFA still resolves no elevated access', async () => {
    // The guest has no MFA, so use the flag directly: an actor whose organization requires
    // MFA and has not satisfied it is denied everything by the engine.
    const ctx = await resolveActorContext(db.pool, {
      userId: guest.userId,
      organizationId: agencyOrg,
      mfaSatisfied: false,
    });
    if (ctx === undefined) throw new Error('unresolved');
    const withPolicy = { ...ctx, mfaRequired: true };
    const decision = decide(withPolicy, 'social.post:approve', {
      type: 'post',
      id: 'p',
      workspaceId: acme,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('mfa_required');
  });
});
