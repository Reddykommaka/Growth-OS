/**
 * OAuth sign-in and account linking — real protocol, real PostgreSQL.
 *
 * The provider is a genuine OIDC issuer running in-process: real RS256 signing, a real JWKS
 * that `openid-client` fetches, real authorization-code exchange with real PKCE verification.
 * Nothing here bypasses the protocol, so a broken state check or a disabled PKCE check would
 * fail these tests rather than sail through them.
 *
 * Lives outside application/ because it wires the real infrastructure adapters, which that
 * layer's import rules forbid — correctly, since this is not a test OF the application layer
 * but of the whole federated path.
 */
import { hashToken } from '@growth-os/authn';
import { ValidationError } from '@growth-os/errors';
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
  authenticateSession,
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
    // Only because the test issuer is loopback HTTP. A test below asserts no production
    // provider may set this.
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
}, 180_000);

afterAll(async () => {
  await idp.close();
  await closeIdentityFixture(fixture);
});

beforeEach(async () => {
  await fixture.db.pool.query('DELETE FROM oauth_authorization_requests');
  await resetIdentityTables(fixture);
});

/** Drives a full, honest round trip: begin → authorize at the IdP → callback. */
async function fullFlow(
  claims: Parameters<OidcTestServer['setNextUser']>[0],
  overrides: { purpose?: 'sign_in' | 'link'; linkUserId?: string } = {},
) {
  idp.setNextUser(claims);
  const begun = await beginOAuth(deps, {
    provider: PROVIDER,
    purpose: overrides.purpose ?? 'sign_in',
    redirectUri: REDIRECT,
    ...(overrides.linkUserId === undefined ? {} : { linkUserId: overrides.linkUserId }),
  });
  const callbackUrl = await idp.authorize(begun.authorizationUrl);
  return {
    begun,
    callbackUrl,
    result: await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl,
      state: begun.state,
    }),
  };
}

async function localUser(email: string, verified: boolean): Promise<string> {
  const { userId, verificationToken } = await register(fixture.h, { email, password: PASSWORD });
  if (verified) await verifyEmail(fixture.h, verificationToken);
  return userId;
}

describe('the authorization request is protocol-correct', () => {
  it('sends S256 PKCE, state and a nonce', async () => {
    const begun = await beginOAuth(deps, {
      provider: PROVIDER,
      purpose: 'sign_in',
      redirectUri: REDIRECT,
    });
    const url = new URL(begun.authorizationUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe(begun.state);
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
  });

  it('stores only the HASH of state, and encrypts the verifier and nonce', async () => {
    const begun = await beginOAuth(deps, {
      provider: PROVIDER,
      purpose: 'sign_in',
      redirectUri: REDIRECT,
    });
    const stored = await fixture.db.pool.query<{
      state_hash: Buffer;
      pkce_verifier_encrypted: Buffer;
      nonce_encrypted: Buffer;
    }>(
      'SELECT state_hash, pkce_verifier_encrypted, nonce_encrypted FROM oauth_authorization_requests',
    );
    const row = stored.rows[0];
    expect(row?.state_hash.equals(hashToken(begun.state))).toBe(true);

    const url = new URL(begun.authorizationUrl);
    const challenge = url.searchParams.get('code_challenge') ?? '';
    // The verifier is encrypted, so neither it nor its challenge is readable in the row.
    expect(row?.pkce_verifier_encrypted.toString('utf8')).not.toContain(challenge);
    expect(row?.nonce_encrypted.toString('utf8')).not.toContain(
      url.searchParams.get('nonce') ?? 'x',
    );
  });

  /** REDIRECT URI VALIDATION — an unchecked redirect delivers the code to the attacker. */
  it('refuses a redirect URI that is not registered', async () => {
    for (const bad of [
      'https://attacker.test/callback',
      'https://app.growth-os.test/auth/callback/../evil',
      'https://app.growth-os.test.attacker.test/auth/callback',
      'https://app.growth-os.test/auth/callback?next=//attacker.test',
      'http://app.growth-os.test/auth/callback',
    ]) {
      await expect(
        beginOAuth(deps, { provider: PROVIDER, purpose: 'sign_in', redirectUri: bad }),
        bad,
      ).rejects.toThrow(ValidationError);
    }
  });

  it('refuses an unknown provider', async () => {
    await expect(
      beginOAuth(deps, { provider: 'nope', purpose: 'sign_in', redirectUri: REDIRECT }),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses a sign-in request that names a user', async () => {
    await expect(
      beginOAuth(deps, {
        provider: PROVIDER,
        purpose: 'sign_in',
        redirectUri: REDIRECT,
        linkUserId: '00000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toThrow(/cannot name a user/i);
  });

  it('refuses a link request with no user', async () => {
    await expect(
      beginOAuth(deps, { provider: PROVIDER, purpose: 'link', redirectUri: REDIRECT }),
    ).rejects.toThrow(/requires an authenticated user/i);
  });

  it('keeps state, the verifier and the nonce out of the audit log', async () => {
    const begun = await beginOAuth(deps, {
      provider: PROVIDER,
      purpose: 'sign_in',
      redirectUri: REDIRECT,
    });
    const serialised = JSON.stringify(fixture.h.audit.events);
    expect(serialised).not.toContain(begun.state);
    expect(serialised).not.toContain(new URL(begun.authorizationUrl).searchParams.get('nonce'));
  });
});

describe('case 1 — a new user signs in with OAuth', () => {
  it('creates an active, verified account and a session', async () => {
    const { result } = await fullFlow({
      sub: 'idp-user-1',
      email: 'ada@example.test',
      email_verified: true,
      name: 'Ada',
    });
    expect(result.outcome).toBe('authenticated');
    if (result.outcome !== 'authenticated') return;
    expect(result.createdUser).toBe(true);

    const user = await fixture.h.users.findById(result.userId);
    expect(user?.status).toBe('active');
    expect(user?.emailVerifiedAt).not.toBeNull();
    // No password: the account has only ever federated.
    expect(user?.passwordHash).toBeNull();
    expect((await authenticateSession(fixture.h, result.token)).ok).toBe(true);
  });

  it('really exchanged a code at the token endpoint', async () => {
    const before = idp.tokenRequests();
    await fullFlow({ sub: 'idp-user-2', email: 'grace@example.test', email_verified: true });
    expect(idp.tokenRequests()).toBe(before + 1);
  });

  it('signs the same person in again without creating a second account', async () => {
    const first = await fullFlow({
      sub: 'idp-same',
      email: 'same@example.test',
      email_verified: true,
    });
    const second = await fullFlow({
      sub: 'idp-same',
      email: 'same@example.test',
      email_verified: true,
    });
    if (first.result.outcome !== 'authenticated' || second.result.outcome !== 'authenticated') {
      throw new Error('expected both to authenticate');
    }
    expect(second.result.userId).toBe(first.result.userId);
    expect(second.result.createdUser).toBe(false);
  });
});

describe('cases 3 and 4 — an existing account already holds the address', () => {
  /**
   * THE CENTRAL SECURITY PROPERTY. A matching email must never hand over an account.
   */
  it('REFUSES to sign in when a VERIFIED account holds the address', async () => {
    const existing = await localUser('ada@example.test', true);
    const { result } = await fullFlow({
      sub: 'idp-stranger',
      email: 'ada@example.test',
      email_verified: true,
    });
    expect(result.outcome).toBe('link_required');
    // No session was created for anyone.
    expect((await fixture.db.pool.query('SELECT 1 FROM sessions')).rowCount).toBe(0);
    // And no identity was attached to the existing user.
    expect(await deps.identities.listForUser(existing)).toEqual([]);
  });

  it('REFUSES equally when the existing account is UNVERIFIED', async () => {
    // The tempting case: the provider proved the address and we never did. Handing the
    // account over is exactly the takeover primitive — an attacker registers against a
    // victim's address and waits.
    const existing = await localUser('ada@example.test', false);
    const { result } = await fullFlow({
      sub: 'idp-stranger-2',
      email: 'ada@example.test',
      email_verified: true,
    });
    expect(result.outcome).toBe('link_required');
    expect(await deps.identities.listForUser(existing)).toEqual([]);
  });

  it('refuses an address the PROVIDER has not verified, creating nothing', async () => {
    const { result } = await fullFlow({
      sub: 'idp-unverified',
      email: 'ada@example.test',
      email_verified: false,
    });
    expect(result).toEqual({ outcome: 'failed', reason: 'email_unverified' });
    expect((await fixture.db.pool.query('SELECT 1 FROM users')).rowCount).toBe(0);
  });

  /**
   * The string-vs-boolean coercion. `"false"` is truthy in JavaScript, so a permissive read
   * of this claim turns an unverified address into an account.
   */
  it('treats the STRING "false" as unverified', async () => {
    const { result } = await fullFlow({
      sub: 'idp-string-false',
      email: 'ada@example.test',
      email_verified: 'false',
    });
    expect(result).toEqual({ outcome: 'failed', reason: 'email_unverified' });
  });

  it('refuses when the provider returns no address at all', async () => {
    const { result } = await fullFlow({ sub: 'idp-no-email' });
    expect(result).toEqual({ outcome: 'failed', reason: 'no_email' });
  });
});
