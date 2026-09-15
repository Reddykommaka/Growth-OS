/**
 * OAuth sign-in and account linking.
 *
 * Two legs. `beginOAuth` mints state, a PKCE verifier and a nonce, records them, and returns
 * the provider's authorization URL. `completeOAuth` consumes that record exactly once,
 * re-verifies everything through the provider port, and applies the linking rules.
 *
 * Provider tokens are never stored. We exchange the code, read the verified subject and
 * email, and drop them — see migration 0009 for why keeping them would be a liability with
 * no corresponding benefit.
 */

import { randomUUID } from 'node:crypto';
import { hashToken } from '@growth-os/authn';
import { ValidationError } from '@growth-os/errors';
import { completeLink, completeSignIn, fail } from './oauth-flows.js';
import type { VerifiedProviderIdentity } from './oauth-port.js';

export type {
  BeginOAuthInput,
  BeginOAuthResult,
  CompleteOAuthInput,
  OAuthDependencies,
  OAuthOutcome,
} from './oauth-types.js';
export { OAUTH_REQUEST_TTL_MS } from './oauth-types.js';

import type {
  BeginOAuthInput,
  BeginOAuthResult,
  CompleteOAuthInput,
  OAuthDependencies,
  OAuthOutcome,
} from './oauth-types.js';
import { OAUTH_REQUEST_TTL_MS } from './oauth-types.js';

/**
 * Starts an OAuth flow.
 *
 * The redirect URI is checked against the provider's allowlist HERE, before anything is
 * recorded. An unchecked redirect is how an authorization code is delivered to an attacker,
 * and checking it only in the callback is too late — the code has already been sent.
 */
export async function beginOAuth(
  deps: OAuthDependencies,
  input: BeginOAuthInput,
): Promise<BeginOAuthResult> {
  const provider = deps.providers.get(input.provider);
  if (provider === undefined) {
    throw new ValidationError('That sign-in provider is not available.');
  }

  // Exact match against the allowlist. Not a prefix or hostname comparison: `startsWith`
  // accepts `https://app.example.test.attacker.test`, and a hostname check accepts any path
  // on our own domain, including one that reflects the query string.
  if (!provider.allowedRedirectUris.includes(input.redirectUri)) {
    throw new ValidationError('That redirect URI is not registered for this provider.');
  }

  if (input.purpose === 'link' && input.linkUserId === undefined) {
    throw new ValidationError('Linking an account requires an authenticated user.');
  }
  if (input.purpose === 'sign_in' && input.linkUserId !== undefined) {
    // A sign-in request must never nominate whose account an identity will attach to.
    throw new ValidationError('A sign-in request cannot name a user.');
  }

  const now = deps.clock.now();
  const started = await provider.startAuthorization(input.redirectUri);

  await deps.oauthRequests.create({
    id: randomUUID(),
    provider: provider.id,
    // Hash, never the value — as for every other token here.
    stateHash: hashToken(started.state),
    pkceVerifierEncrypted: deps.cipher.encrypt(Buffer.from(started.codeVerifier, 'utf8')),
    nonceEncrypted: deps.cipher.encrypt(Buffer.from(started.nonce, 'utf8')),
    redirectUri: input.redirectUri,
    purpose: input.purpose,
    ...(input.linkUserId === undefined ? {} : { linkUserId: input.linkUserId }),
    ...(input.ip === undefined ? {} : { ip: input.ip }),
    ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
    expiresAt: new Date(now.getTime() + OAUTH_REQUEST_TTL_MS),
  });

  await deps.audit.record({
    action: 'identity.oauth.started',
    actorUserId: input.linkUserId ?? null,
    resourceType: 'oauth_request',
    resourceId: provider.id,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
    // No state, no verifier, no nonce. All three are live secrets for ten minutes.
    metadata: { provider: provider.id, purpose: input.purpose },
  });

  return { authorizationUrl: started.url, state: started.state };
}

/**
 * Completes an OAuth flow.
 *
 * Every failure returns a single opaque `failed` outcome to the caller's caller. The `reason`
 * is for the audit log and the server's own logs: telling a caller whether the state was
 * unknown, expired or replayed narrows an attack for them at no cost.
 */
export async function completeOAuth(
  deps: OAuthDependencies,
  input: CompleteOAuthInput,
): Promise<OAuthOutcome> {
  const now = deps.clock.now();

  if (deps.rateLimiter !== undefined) {
    const allowed = await deps.rateLimiter.consume(`oauth:${input.ip ?? 'unknown'}`);
    if (!allowed) return { outcome: 'rate_limited' };
  }

  const record = await deps.oauthRequests.findByStateHash(hashToken(input.state));
  if (record === undefined) return await fail(deps, input, 'invalid_state');
  // A state minted for Google must not complete a Microsoft callback.
  if (record.provider !== input.provider) return await fail(deps, input, 'invalid_state');
  if (record.expiresAt <= now) return await fail(deps, input, 'expired');

  // Single-use, settled by the write. A replayed callback races the honest one and loses.
  if (!(await deps.oauthRequests.consume(record.id, now))) {
    return await fail(deps, input, 'replayed');
  }

  const provider = deps.providers.get(record.provider);
  if (provider === undefined) return await fail(deps, input, 'exchange_failed');

  let identity: VerifiedProviderIdentity;
  try {
    identity = await provider.exchangeCallback({
      callbackUrl: input.callbackUrl,
      expectedState: input.state,
      codeVerifier: deps.cipher.decrypt(record.pkceVerifierEncrypted).toString('utf8'),
      expectedNonce: deps.cipher.decrypt(record.nonceEncrypted).toString('utf8'),
    });
  } catch {
    // Every protocol failure collapses to one outcome: a bad PKCE verifier, an expired code,
    // a signature that does not verify and a nonce mismatch are indistinguishable to the
    // caller, so none of them is an oracle.
    return await fail(deps, input, 'exchange_failed');
  }

  return record.purpose === 'link' && record.linkUserId !== null
    ? await completeLink(deps, record.linkUserId, identity, input)
    : await completeSignIn(deps, identity, input);
}
