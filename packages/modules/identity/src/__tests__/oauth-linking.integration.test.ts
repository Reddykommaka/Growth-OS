/**
 * OAuth ACCOUNT LINKING — real issuer, real PostgreSQL.
 *
 * Cases 2, 5 and 6: an existing user linking a provider, an identity already bound to
 * someone else, and a provider that changes the address it asserts. The protocol-level
 * attacks live in oauth-protocol.integration.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeIdentityFixture,
  type IdentityFixture,
  openIdentityFixture,
  TEST_PASSWORD as PASSWORD,
  resetIdentityTables,
} from '../__testing__/db-fixture.js';
import { type OidcTestServer, startOidcTestServer } from '../__testing__/oidc-test-server.js';
import {
  beginOAuth,
  completeOAuth,
  createProviderRegistry,
  type OAuthDependencies,
  register,
  verifyEmail,
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
  };
}, 180_000);

afterAll(async () => {
  await idp.close();
  await closeIdentityFixture(fixture);
});

beforeEach(async () => {
  await fixture.db.pool.query('DELETE FROM oauth_authorization_requests');
  await resetIdentityTables(fixture);
});

async function begin(purpose: 'sign_in' | 'link', linkUserId?: string) {
  return await beginOAuth(deps, {
    provider: PROVIDER,
    purpose,
    redirectUri: REDIRECT,
    ...(linkUserId === undefined ? {} : { linkUserId }),
  });
}

async function localUser(email: string, verified = true): Promise<string> {
  const { userId, verificationToken } = await register(fixture.h, { email, password: PASSWORD });
  if (verified) await verifyEmail(fixture.h, verificationToken);
  return userId;
}

describe('case 2 — an existing verified user links a provider', () => {
  it('attaches the identity and does not create a second account', async () => {
    const userId = await localUser('ada@example.test');
    idp.setNextUser({ sub: 'idp-ada', email: 'ada@example.test', email_verified: true });

    const begun = await begin('link', userId);
    const callbackUrl = await idp.authorize(begun.authorizationUrl);
    const result = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl,
      state: begun.state,
    });

    expect(result).toEqual({ outcome: 'linked', userId });
    expect((await fixture.db.pool.query('SELECT 1 FROM users')).rowCount).toBe(1);
  });

  it('then signs in automatically on the next attempt', async () => {
    const userId = await localUser('ada@example.test');
    idp.setNextUser({ sub: 'idp-ada', email: 'ada@example.test', email_verified: true });
    const link = await begin('link', userId);
    await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl: await idp.authorize(link.authorizationUrl),
      state: link.state,
    });

    idp.setNextUser({ sub: 'idp-ada', email: 'ada@example.test', email_verified: true });
    const signIn = await begin('sign_in');
    const result = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl: await idp.authorize(signIn.authorizationUrl),
      state: signIn.state,
    });
    expect(result.outcome).toBe('authenticated');
    if (result.outcome !== 'authenticated') return;
    expect(result.userId).toBe(userId);
    expect(result.createdUser).toBe(false);
  });

  it('is idempotent when the same user links the same identity again', async () => {
    const userId = await localUser('ada@example.test');
    for (let i = 0; i < 2; i++) {
      idp.setNextUser({ sub: 'idp-ada', email: 'ada@example.test', email_verified: true });
      const begun = await begin('link', userId);
      const result = await completeOAuth(deps, {
        provider: PROVIDER,
        callbackUrl: await idp.authorize(begun.authorizationUrl),
        state: begun.state,
      });
      expect(['linked', 'already_linked']).toContain(result.outcome);
    }
    expect(await deps.identities.listForUser(userId)).toHaveLength(1);
  });
});

describe('case 5 — the identity is already linked to ANOTHER user', () => {
  /**
   * The back-door takeover. If a second user could claim an identity already bound to
   * someone else, they would attach the victim's provider subject to their own account and
   * then sign in as the victim.
   */
  it('refuses the link and leaves the original binding intact', async () => {
    const victim = await localUser('victim@example.test');
    const attacker = await localUser('attacker@example.test');

    idp.setNextUser({ sub: 'idp-shared', email: 'victim@example.test', email_verified: true });
    const first = await begin('link', victim);
    await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl: await idp.authorize(first.authorizationUrl),
      state: first.state,
    });

    idp.setNextUser({ sub: 'idp-shared', email: 'victim@example.test', email_verified: true });
    const second = await begin('link', attacker);
    const result = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl: await idp.authorize(second.authorizationUrl),
      state: second.state,
    });

    expect(result).toEqual({ outcome: 'failed', reason: 'linked_to_another_user' });
    expect(await deps.identities.listForUser(attacker)).toEqual([]);
    expect(await deps.identities.listForUser(victim)).toHaveLength(1);
  });

  it('refuses a second identity from the same provider for one user', async () => {
    const userId = await localUser('ada@example.test');
    idp.setNextUser({ sub: 'idp-one', email: 'ada@example.test', email_verified: true });
    const first = await begin('link', userId);
    await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl: await idp.authorize(first.authorizationUrl),
      state: first.state,
    });

    idp.setNextUser({ sub: 'idp-two', email: 'other@example.test', email_verified: true });
    const second = await begin('link', userId);
    const result = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl: await idp.authorize(second.authorizationUrl),
      state: second.state,
    });
    // Two Google identities on one account make "unlink Google" ambiguous, and ambiguity in
    // a credential-removal path is how a credential survives its own removal.
    expect(result).toEqual({ outcome: 'failed', reason: 'provider_already_linked' });
  });
});

describe('case 6 — the provider returns a changed email', () => {
  it('updates the IDENTITY record but never the account email', async () => {
    const userId = await localUser('ada@example.test');
    idp.setNextUser({ sub: 'idp-ada', email: 'ada@example.test', email_verified: true });
    const link = await begin('link', userId);
    await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl: await idp.authorize(link.authorizationUrl),
      state: link.state,
    });

    // The provider now asserts a different address for the same subject.
    idp.setNextUser({ sub: 'idp-ada', email: 'ada.new@example.test', email_verified: true });
    const signIn = await begin('sign_in');
    const result = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl: await idp.authorize(signIn.authorizationUrl),
      state: signIn.state,
    });
    expect(result.outcome).toBe('authenticated');

    // The identity's own record follows the provider...
    const identities = await deps.identities.listForUser(userId);
    expect(identities[0]?.email).toBe('ada.new@example.test');
    // ...but the ACCOUNT email is unchanged. A silent change there is a takeover with extra
    // steps: the provider proving a new address says nothing about the account holder
    // wanting their login address moved.
    expect((await fixture.h.users.findById(userId))?.email).toBe('ada@example.test');
  });
});
