/**
 * CASES 14-16: OAUTH AUTHENTICATION MUST NOT BYPASS AUTHORIZATION.
 *
 * The same claim already proven for password sign-in (authorization.integration.test.ts),
 * re-proven for the federated path — because the federated path is a second front door, and
 * a second front door is exactly where an authorization check gets forgotten.
 *
 * Every session below is minted by a real OIDC round trip against a real issuer.
 */

import { randomUUID } from 'node:crypto';
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
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeIdentityFixture,
  type IdentityFixture,
  openIdentityFixture,
} from '../__testing__/db-fixture.js';
import { type OidcTestServer, startOidcTestServer } from '../__testing__/oidc-test-server.js';
import {
  authenticateSession,
  beginOAuth,
  completeOAuth,
  createProviderRegistry,
  type OAuthDependencies,
} from '../application/index.js';
import {
  createOAuthRequestRepository,
  createOidcProvider,
  createUserIdentityRepository,
} from '../infrastructure/index.js';

const REDIRECT = 'https://app.growth-os.test/auth/callback';
const PROVIDER = 'testidp';

let fixture: IdentityFixture;
let idp: OidcTestServer;
let deps: OAuthDependencies;

let agencyOrg: string;
let rivalOrg: string;
let acme: string;
let borealis: string;

const staff = { email: 'staff@agency.test', sub: 'idp-staff', userId: '' };
const guest = { email: 'reviewer@client.test', sub: 'idp-guest', userId: '' };
const stranger = { email: 'stranger@elsewhere.test', sub: 'idp-stranger', userId: '' };

/** A full OIDC round trip, returning the session token and user id. */
async function oauthSignIn(sub: string, email: string) {
  idp.setNextUser({ sub, email, email_verified: true });
  const begun = await beginOAuth(deps, {
    provider: PROVIDER,
    purpose: 'sign_in',
    redirectUri: REDIRECT,
  });
  const result = await completeOAuth(deps, {
    provider: PROVIDER,
    callbackUrl: await idp.authorize(begun.authorizationUrl),
    state: begun.state,
  });
  if (result.outcome !== 'authenticated') throw new Error(`expected auth, got ${result.outcome}`);
  return result;
}

async function asOwner<T>(
  organizationId: string,
  ownerUserId: string,
  body: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const ctx = await resolveActorContext(fixture.db.pool, {
    userId: ownerUserId,
    organizationId,
    mfaSatisfied: true,
  });
  if (ctx === undefined) throw new Error('owner did not resolve');
  return await withTenant(
    fixture.db.pool,
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
  fixture = await openIdentityFixture();
  idp = await startOidcTestServer();
  const provider = await createOidcProvider({
    id: PROVIDER,
    displayName: 'Test IdP',
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    allowedRedirectUris: [REDIRECT],
    allowInsecureIssuer: true,
  });
  deps = {
    providers: createProviderRegistry([provider]),
    oauthRequests: createOAuthRequestRepository(fixture.db.pool),
    identities: createUserIdentityRepository(fixture.db.pool),
    users: fixture.h.users,
    sessions: fixture.h.sessions,
    audit: fixture.h.audit,
    clock: fixture.h.clock,
    cipher: fixture.h.cipher,
    unitOfWork: fixture.h.unitOfWork,
  };

  // Every account below is created by a real federated sign-in, not seeded.
  staff.userId = (await oauthSignIn(staff.sub, staff.email)).userId;
  guest.userId = (await oauthSignIn(guest.sub, guest.email)).userId;
  stranger.userId = (await oauthSignIn(stranger.sub, stranger.email)).userId;
  const principal = await oauthSignIn('idp-principal', 'principal@agency.test');
  const rivalOwner = await oauthSignIn('idp-rival', 'owner@rival.test');

  const agency = await provisionOrganization(fixture.db.pool, {
    name: 'Northwind',
    slug: 'northwind',
    kind: 'agency',
    ownerUserId: principal.userId,
  });
  agencyOrg = agency.organizationId;
  const rival = await provisionOrganization(fixture.db.pool, {
    name: 'Rival',
    slug: 'rival',
    kind: 'agency',
    ownerUserId: rivalOwner.userId,
  });
  rivalOrg = rival.organizationId;

  await asOwner(agencyOrg, principal.userId, async (c) => {
    const podA = await createTeam(c, agencyOrg, 'pod-a', 'Pod A');
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
  await idp.close();
  await closeIdentityFixture(fixture);
});

describe('case 14 — organization and workspace authorization after OAuth', () => {
  it('an OAuth session authenticates', async () => {
    const session = await oauthSignIn(staff.sub, staff.email);
    expect((await authenticateSession(fixture.h, session.token)).ok).toBe(true);
  });

  it('a federated stranger gets NO actor context in an organization they do not belong to', async () => {
    await oauthSignIn(stranger.sub, stranger.email);
    expect(
      await resolveActorContext(fixture.db.pool, {
        userId: stranger.userId,
        organizationId: agencyOrg,
        mfaSatisfied: true,
      }),
    ).toBeUndefined();
  });

  it('a federated member reaches only the workspace their role names', async () => {
    const ctx = await resolveActorContext(fixture.db.pool, {
      userId: staff.userId,
      organizationId: agencyOrg,
      mfaSatisfied: true,
    });
    expect(ctx?.accessibleWorkspaceIds).toEqual([acme]);
    expect(ctx?.workspaceScope).toBe('set');
  });

  it('is denied a sibling workspace by the engine AND at the database', async () => {
    const ctx = await resolveActorContext(fixture.db.pool, {
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

    const rows = await withTenant(
      fixture.db.pool,
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

  it('is denied organization administration', async () => {
    const ctx = await resolveActorContext(fixture.db.pool, {
      userId: staff.userId,
      organizationId: agencyOrg,
      mfaSatisfied: true,
    });
    if (ctx === undefined) throw new Error('unresolved');
    for (const permission of [
      'organization.member:invite',
      'organization.role_assignment:grant',
      'billing.subscription:manage',
    ] as const) {
      expect(decide(ctx, permission).allowed, permission).toBe(false);
    }
  });
});

describe('case 15 — client_guest restrictions survive federation', () => {
  it('reaches exactly one workspace', async () => {
    const ctx = await resolveActorContext(fixture.db.pool, {
      userId: guest.userId,
      organizationId: agencyOrg,
      mfaSatisfied: true,
    });
    expect(ctx?.accessibleWorkspaceIds).toEqual([acme]);
  });

  it('may approve in their own workspace and nothing in another', async () => {
    const ctx = await resolveActorContext(fixture.db.pool, {
      userId: guest.userId,
      organizationId: agencyOrg,
      mfaSatisfied: true,
    });
    if (ctx === undefined) throw new Error('unresolved');
    expect(
      decide(ctx, 'social.post:approve', { type: 'p', id: '1', workspaceId: acme }).allowed,
    ).toBe(true);
    expect(
      decide(ctx, 'social.post:approve', { type: 'p', id: '1', workspaceId: borealis }).allowed,
    ).toBe(false);
  });

  it("is denied the agency's costs, billing, members and credentials", async () => {
    const ctx = await resolveActorContext(fixture.db.pool, {
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
    ] as const) {
      expect(decide(ctx, permission).allowed, permission).toBe(false);
    }
  });
});

describe('case 16 — cross-tenant access remains impossible', () => {
  it('a federated agency member has no context in the rival organization', async () => {
    expect(
      await resolveActorContext(fixture.db.pool, {
        userId: staff.userId,
        organizationId: rivalOrg,
        mfaSatisfied: true,
      }),
    ).toBeUndefined();
  });

  it("cannot read the rival's workspaces even with a forced context and the widest scope", async () => {
    const rows = await withTenant(
      fixture.db.pool,
      { organizationId: agencyOrg, userId: staff.userId, workspaceIds: [], workspaceScope: 'all' },
      async (tx) =>
        (await tx.query('SELECT slug FROM workspaces WHERE organization_id = $1', [rivalOrg])).rows,
    );
    expect(rows).toEqual([]);
  });

  it('an OAuth session is bound to a user, never to a tenant', async () => {
    const session = await oauthSignIn(staff.sub, staff.email);
    const lookup = await authenticateSession(fixture.h, session.token);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.value.session.activeOrganizationId).toBeNull();
  });

  it('a brand-new federated account belongs to no organization at all', async () => {
    const fresh = await oauthSignIn(`idp-${randomUUID()}`, `${randomUUID()}@example.test`);
    for (const org of [agencyOrg, rivalOrg]) {
      expect(
        await resolveActorContext(fixture.db.pool, {
          userId: fresh.userId,
          organizationId: org,
          mfaSatisfied: true,
        }),
      ).toBeUndefined();
    }
  });
});
