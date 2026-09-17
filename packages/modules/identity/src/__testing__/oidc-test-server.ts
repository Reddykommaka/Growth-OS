/**
 * A REAL OpenID Connect issuer, running in-process over HTTP.
 *
 * Not a mock of our adapter — an actual authorization server. It publishes discovery metadata
 * and a JWKS, issues authorization codes, and signs ID tokens with a real RS256 key that
 * `openid-client` fetches and verifies. The library performs genuine state, PKCE, nonce,
 * signature, issuer, audience and expiry checks against it.
 *
 * That distinction is the whole point. A mock provider that returns a canned identity proves
 * our linking rules and nothing about the protocol; every check the library performs would be
 * skipped, and a flow with PKCE verification disabled would pass just as happily. Here, a
 * wrong verifier genuinely fails the token endpoint, and a replayed code genuinely gets
 * rejected — because this server enforces it.
 *
 * It also lets the tests do things no real provider would cooperate with: issue a token for a
 * changed email, expire a code on demand, or assert an unverified address.
 */
// `CryptoKey` is a DOM global, and this project's lib is ES2023 only. Node's own webcrypto
// namespace declares the same type, so the key `jose` hands back is named without pulling
// the entire DOM lib into a server-side project.
import type { webcrypto as NodeWebCrypto } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type JWK, type KeyObject, SignJWT } from 'jose';

export interface TestUserClaims {
  readonly sub: string;
  readonly email?: string | undefined;
  readonly email_verified?: unknown;
  readonly name?: string | undefined;
}

interface StoredCode {
  readonly claims: TestUserClaims;
  readonly codeChallenge: string;
  readonly nonce: string;
  readonly redirectUri: string;
  used: boolean;
  expiresAt: number;
}

export interface OidcTestServer {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Queues the identity the next authorization will produce. */
  setNextUser(claims: TestUserClaims): void;
  /** Drives the authorization endpoint the way a browser would, returning the callback URL. */
  authorize(authorizationUrl: string): Promise<string>;
  /** Expires every outstanding code, to exercise the expired-code path. */
  expireAllCodes(): void;
  /** How many times the token endpoint was called — proves an exchange really happened. */
  readonly tokenRequests: () => number;
  close(): Promise<void>;
}

/** RFC 7636 §4.6 verification, performed by the server exactly as a real one does. */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString('base64url');
}

function json(res: import('node:http').ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The OIDC discovery document, advertising only what this server actually implements. */
function discoveryDocument(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code'],
  };
}

/**
 * The token endpoint's grant checks, as a real authorization server performs them.
 *
 * Returns an OAuth error code, or undefined when the grant is valid. Separated out so each
 * rule reads as one line — these are the checks that make the tests exercise the protocol
 * rather than a stub, so they need to be obvious.
 */
async function rejectGrant(
  stored: StoredCode,
  params: URLSearchParams,
): Promise<string | undefined> {
  // Authorization codes are single-use (RFC 6749 §4.1.2), enforced HERE so a replayed
  // callback fails at the server rather than only at our own consume() guard.
  if (stored.used) return 'invalid_grant';
  if (Date.now() > stored.expiresAt) return 'invalid_grant';
  // Real PKCE verification (RFC 7636 §4.6).
  if ((await s256(params.get('code_verifier') ?? '')) !== stored.codeChallenge) {
    return 'invalid_grant';
  }
  if (params.get('redirect_uri') !== stored.redirectUri) return 'invalid_grant';
  return undefined;
}

interface TokenContext {
  readonly codes: Map<string, StoredCode>;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly privateKey: NodeWebCrypto.CryptoKey | KeyObject;
  readonly issuer: string;
}

/** The token endpoint: validates the grant, then signs a real RS256 ID token. */
async function handleToken(
  ctx: TokenContext,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const body = await new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += String(chunk);
    });
    req.on('end', () => resolve(data));
  });
  const params = new URLSearchParams(body);

  const deny = (error: string): void => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error }));
  };

  const stored = ctx.codes.get(params.get('code') ?? '');
  const rejection = stored === undefined ? 'invalid_grant' : await rejectGrant(stored, params);
  if (stored === undefined || rejection !== undefined) return deny(rejection ?? 'invalid_grant');

  stored.used = true;

  const idToken = await new SignJWT({
    ...(stored.claims.email === undefined ? {} : { email: stored.claims.email }),
    ...(stored.claims.email_verified === undefined
      ? {}
      : { email_verified: stored.claims.email_verified }),
    ...(stored.claims.name === undefined ? {} : { name: stored.claims.name }),
    nonce: stored.nonce,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(ctx.issuer)
    .setSubject(stored.claims.sub)
    .setAudience(ctx.clientId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(ctx.privateKey);

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      access_token: 'test-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: idToken,
    }),
  );
}

export async function startOidcTestServer(): Promise<OidcTestServer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = {
    ...(await exportJWK(publicKey as KeyObject)),
    kid: 'test-key',
    use: 'sig',
    alg: 'RS256',
  };

  const clientId = 'growth-os-test-client';
  const clientSecret = 'growth-os-test-secret';
  const codes = new Map<string, StoredCode>();
  let nextUser: TestUserClaims = { sub: 'default-subject' };
  let tokenCalls = 0;
  let issuer = '';

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(res, discoveryDocument(issuer));
    }
    if (url.pathname === '/jwks') return json(res, { keys: [jwk] });
    if (url.pathname === '/token') {
      tokenCalls += 1;
      void handleToken({ codes, clientId, clientSecret, privateKey, issuer }, req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    setNextUser(claims) {
      nextUser = claims;
    },
    async authorize(authorizationUrl) {
      const url = new URL(authorizationUrl);
      const challenge = url.searchParams.get('code_challenge');
      const nonce = url.searchParams.get('nonce');
      const state = url.searchParams.get('state');
      const redirectUri = url.searchParams.get('redirect_uri');
      if (challenge === null || nonce === null || state === null || redirectUri === null) {
        throw new Error('The authorization request was missing a required parameter.');
      }
      if (url.searchParams.get('code_challenge_method') !== 'S256') {
        throw new Error('The authorization request did not use S256.');
      }

      const code = `code-${Math.random().toString(36).slice(2)}`;
      codes.set(code, {
        claims: nextUser,
        codeChallenge: challenge,
        nonce,
        redirectUri,
        used: false,
        expiresAt: Date.now() + 60_000,
      });
      return `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    },
    expireAllCodes() {
      for (const stored of codes.values()) stored.expiresAt = 0;
    },
    tokenRequests: () => tokenCalls,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
