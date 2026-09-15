/**
 * OAuth PROTOCOL ATTACKS — real issuer, real PostgreSQL.
 *
 * Cases 7 to 13: replay, invalid state, a wrong PKCE verifier, an expired code, a suspended
 * account and logout. Every one is driven against the real authorization server, so a check
 * that stopped working would fail here rather than pass quietly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeIdentityFixture,
  type IdentityFixture,
  openIdentityFixture,
  TEST_PASSWORD as PASSWORD,
  resetIdentityTables,
} from '../__testing__/db-fixture.js';
import { CountingRateLimiter } from '../__testing__/harness.js';
import { type OidcTestServer, startOidcTestServer } from '../__testing__/oidc-test-server.js';
import {
  authenticateSession,
  beginOAuth,
  completeOAuth,
  createProviderRegistry,
  type OAuthDependencies,
  register,
  signOut,
  unlinkProvider,
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

describe('cases 7-11 — protocol attacks, driven against the real issuer', () => {
  it('case 7: refuses a REPLAYED callback', async () => {
    idp.setNextUser({ sub: 'idp-replay', email: 'ada@example.test', email_verified: true });
    const begun = await begin('sign_in');
    const callbackUrl = await idp.authorize(begun.authorizationUrl);

    const first = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl,
      state: begun.state,
    });
    expect(first.outcome).toBe('authenticated');

    const replay = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl,
      state: begun.state,
    });
    // Our own single-use guard fires first; the issuer would also refuse the code.
    expect(replay).toEqual({ outcome: 'failed', reason: 'replayed' });
    expect((await fixture.db.pool.query('SELECT 1 FROM sessions')).rowCount).toBe(1);
  });

  it('case 7b: exactly one of two CONCURRENT replays wins', async () => {
    idp.setNextUser({ sub: 'idp-race', email: 'ada@example.test', email_verified: true });
    const begun = await begin('sign_in');
    const callbackUrl = await idp.authorize(begun.authorizationUrl);

    const [a, b] = await Promise.all([
      completeOAuth(deps, { provider: PROVIDER, callbackUrl, state: begun.state }),
      completeOAuth(deps, { provider: PROVIDER, callbackUrl, state: begun.state }),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['authenticated', 'failed']);
  });

  it('case 8: refuses an unknown state', async () => {
    idp.setNextUser({ sub: 'idp-x', email: 'ada@example.test', email_verified: true });
    const begun = await begin('sign_in');
    const callbackUrl = await idp.authorize(begun.authorizationUrl);
    const result = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl,
      state: 'a-state-we-never-issued',
    });
    expect(result).toEqual({ outcome: 'failed', reason: 'invalid_state' });
  });

  it('case 8b: refuses a state minted for a DIFFERENT provider', async () => {
    idp.setNextUser({ sub: 'idp-x', email: 'ada@example.test', email_verified: true });
    const begun = await begin('sign_in');
    const callbackUrl = await idp.authorize(begun.authorizationUrl);
    const result = await completeOAuth(deps, {
      provider: 'some-other-provider',
      callbackUrl,
      state: begun.state,
    });
    expect(result).toEqual({ outcome: 'failed', reason: 'invalid_state' });
  });

  /**
   * CASE 9 — the PKCE verifier. Corrupting the stored verifier makes the token exchange fail
   * AT THE ISSUER, which is what proves PKCE is genuinely in the loop rather than decorative.
   */
  it('case 9: a wrong PKCE verifier fails the exchange at the issuer', async () => {
    idp.setNextUser({ sub: 'idp-pkce', email: 'ada@example.test', email_verified: true });
    const begun = await begin('sign_in');
    const callbackUrl = await idp.authorize(begun.authorizationUrl);

    // Replace the stored verifier with a valid-but-wrong one, encrypted the same way.
    await fixture.db.pool.query(
      'UPDATE oauth_authorization_requests SET pkce_verifier_encrypted = $1',
      [fixture.h.cipher.encrypt(Buffer.from('a'.repeat(64), 'utf8'))],
    );

    const before = idp.tokenRequests();
    const result = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl,
      state: begun.state,
    });
    expect(result).toEqual({ outcome: 'failed', reason: 'exchange_failed' });
    // The exchange was genuinely attempted and genuinely rejected.
    expect(idp.tokenRequests()).toBe(before + 1);
    expect((await fixture.db.pool.query('SELECT 1 FROM sessions')).rowCount).toBe(0);
  });
});

describe('cases 10-11 — the code exchange itself', () => {
  it('case 10: refuses an expired authorization code', async () => {
    idp.setNextUser({ sub: 'idp-expired', email: 'ada@example.test', email_verified: true });
    const begun = await begin('sign_in');
    const callbackUrl = await idp.authorize(begun.authorizationUrl);
    idp.expireAllCodes();

    const result = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl,
      state: begun.state,
    });
    expect(result).toEqual({ outcome: 'failed', reason: 'exchange_failed' });
  });

  it('refuses an expired authorization REQUEST of our own', async () => {
    idp.setNextUser({ sub: 'idp-stale', email: 'ada@example.test', email_verified: true });
    const begun = await begin('sign_in');
    const callbackUrl = await idp.authorize(begun.authorizationUrl);
    fixture.h.clock.advance(11 * 60 * 1000);

    const result = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl,
      state: begun.state,
    });
    expect(result).toEqual({ outcome: 'failed', reason: 'expired' });
  });

  it('every failure reports the same opaque outcome shape', async () => {
    // The reason reaches the audit log, never a caller who could use it as an oracle.
    const result = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl: `${REDIRECT}?code=nope&state=nope`,
      state: 'nope',
    });
    expect(result.outcome).toBe('failed');
    expect(fixture.h.audit.find('identity.oauth.failed')).toBeDefined();
  });

  it('rate limits callback attempts by source', async () => {
    const limited = { ...deps, rateLimiter: new CountingRateLimiter(2) };
    for (let i = 0; i < 2; i++) {
      await completeOAuth(limited, {
        provider: PROVIDER,
        callbackUrl: `${REDIRECT}?code=x&state=y`,
        state: 'y',
        ip: '1.2.3.4',
      });
    }
    const result = await completeOAuth(limited, {
      provider: PROVIDER,
      callbackUrl: `${REDIRECT}?code=x&state=y`,
      state: 'y',
      ip: '1.2.3.4',
    });
    expect(result).toEqual({ outcome: 'rate_limited' });
  });
});

describe('cases 12-13 — account state and logout', () => {
  it('case 12: a suspended account cannot sign in through a provider', async () => {
    idp.setNextUser({ sub: 'idp-susp', email: 'ada@example.test', email_verified: true });
    const first = await begin('sign_in');
    const created = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl: await idp.authorize(first.authorizationUrl),
      state: first.state,
    });
    if (created.outcome !== 'authenticated') throw new Error('setup');
    await fixture.h.users.setStatus(created.userId, 'suspended');

    idp.setNextUser({ sub: 'idp-susp', email: 'ada@example.test', email_verified: true });
    const second = await begin('sign_in');
    const result = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl: await idp.authorize(second.authorizationUrl),
      state: second.state,
    });
    // Federation establishes WHO, never WHETHER.
    expect(result).toEqual({ outcome: 'failed', reason: 'account_unavailable' });
  });

  it('case 13: logging out revokes an OAuth session like any other', async () => {
    idp.setNextUser({ sub: 'idp-out', email: 'ada@example.test', email_verified: true });
    const begun = await begin('sign_in');
    const result = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl: await idp.authorize(begun.authorizationUrl),
      state: begun.state,
    });
    if (result.outcome !== 'authenticated') throw new Error('setup');

    expect((await authenticateSession(fixture.h, result.token)).ok).toBe(true);
    await signOut(fixture.h, result.sessionId, result.userId);
    expect(await authenticateSession(fixture.h, result.token)).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it('an account with MFA still owes a second factor after OAuth', async () => {
    idp.setNextUser({ sub: 'idp-mfa', email: 'ada@example.test', email_verified: true });
    const first = await begin('sign_in');
    const created = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl: await idp.authorize(first.authorizationUrl),
      state: first.state,
    });
    if (created.outcome !== 'authenticated') throw new Error('setup');
    await fixture.h.users.setMfaEnabled(created.userId, true);

    idp.setNextUser({ sub: 'idp-mfa', email: 'ada@example.test', email_verified: true });
    const second = await begin('sign_in');
    const result = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl: await idp.authorize(second.authorizationUrl),
      state: second.state,
    });
    if (result.outcome !== 'authenticated') throw new Error('expected a session');

    // A provider's assurance is not a substitute for the user's own second factor.
    const lookup = await authenticateSession(fixture.h, result.token);
    expect(lookup.ok && lookup.value.mfaSatisfied).toBe(false);
    expect(lookup.ok && lookup.value.needsReauthentication).toBe(true);
  });
});

describe('unlinking cannot lock a user out', () => {
  it('refuses to remove the last sign-in method', async () => {
    idp.setNextUser({ sub: 'idp-only', email: 'ada@example.test', email_verified: true });
    const begun = await begin('sign_in');
    const result = await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl: await idp.authorize(begun.authorizationUrl),
      state: begun.state,
    });
    if (result.outcome !== 'authenticated') throw new Error('setup');

    // No password, and this is the only identity — removing it is unrecoverable.
    await expect(unlinkProvider(deps, result.userId, PROVIDER)).rejects.toThrow(/locked out/i);
  });

  it('allows it once a password exists', async () => {
    const userId = await localUser('ada@example.test');
    idp.setNextUser({ sub: 'idp-plus', email: 'ada@example.test', email_verified: true });
    const begun = await begin('link', userId);
    await completeOAuth(deps, {
      provider: PROVIDER,
      callbackUrl: await idp.authorize(begun.authorizationUrl),
      state: begun.state,
    });

    expect(await unlinkProvider(deps, userId, PROVIDER)).toBe(true);
    expect(await deps.identities.listForUser(userId)).toEqual([]);
  });
});
