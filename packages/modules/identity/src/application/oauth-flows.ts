/**
 * The OAuth completion flows: sign-in, explicit linking, session issue and unlink.
 *
 * Separated from the protocol half in oauth.ts so the LINKING RULES — the part that decides
 * whose account a provider identity reaches — can be read in one sitting without the state
 * and PKCE machinery in the way.
 */

import { randomUUID } from 'node:crypto';
import { userActor } from '@growth-os/audit';
import { startSession } from '@growth-os/authn';
import { ValidationError } from '@growth-os/errors';
import {
  decideExplicitLink,
  decideLinking,
  shouldUpdateIdentityEmail,
} from '../domain/oauth-linking.js';
import type { ProviderId, VerifiedProviderIdentity } from './oauth-port.js';
import type { CompleteOAuthInput, OAuthDependencies, OAuthOutcome } from './oauth-types.js';

/**
 * Collapses every protocol and policy failure to one opaque outcome.
 *
 * The `reason` reaches the audit log and the server logs, never the caller's caller: telling
 * someone whether the state was unknown, expired or replayed narrows an attack for free.
 */
export async function fail(
  deps: OAuthDependencies,
  input: CompleteOAuthInput,
  reason: Extract<OAuthOutcome, { outcome: 'failed' }>['reason'],
): Promise<OAuthOutcome> {
  await deps.audit.record({
    action: 'identity.oauth.failed',
    result: 'failed',
    actor: userActor(null),
    resourceType: 'oauth_request',
    resourceId: input.provider,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
    metadata: { provider: input.provider, reason },
  });
  return { outcome: 'failed', reason };
}

/**
 * Keeps the IDENTITY's record of the address current.
 *
 * Never touches the user's account email — see shouldUpdateIdentityEmail for why a silent
 * change there would be an account takeover with extra steps.
 */
async function refreshIdentityRecord(
  deps: OAuthDependencies,
  existing: { readonly id: string; readonly email: string | null; readonly emailVerified: boolean },
  identity: VerifiedProviderIdentity,
  now: Date,
): Promise<void> {
  const useProvider = shouldUpdateIdentityEmail(
    existing.email,
    identity.email,
    identity.emailVerified,
  );
  await deps.identities.recordUse(
    existing.id,
    now,
    useProvider ? identity.email : (existing.email ?? undefined),
    useProvider ? identity.emailVerified : existing.emailVerified,
  );
}

/** Provisions a user for a provider-verified address that no account holds. */
async function createFederatedUser(
  deps: OAuthDependencies,
  identity: VerifiedProviderIdentity,
  input: CompleteOAuthInput,
  now: Date,
): Promise<string> {
  const userId = randomUUID();
  await deps.users.create({
    id: userId,
    email: identity.email ?? '',
    // No password. A user who has only ever federated has nothing to verify against, and
    // verifyPassword(null, …) handles that without becoming a timing oracle.
    passwordHash: null,
    ...(identity.name === undefined ? {} : { name: identity.name }),
    status: 'active',
  });
  await deps.users.markEmailVerified(userId, now);
  await deps.identities.link({
    id: randomUUID(),
    userId,
    provider: identity.provider,
    providerUserId: identity.providerUserId,
    email: identity.email,
    emailVerified: identity.emailVerified,
    at: now,
  });
  await deps.audit.record({
    action: 'identity.oauth.user_created',
    result: 'succeeded',
    actor: userActor(userId),
    resourceType: 'user',
    resourceId: userId,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
    metadata: { provider: identity.provider },
  });
  return userId;
}

/** Applies the linking rules for a sign-in attempt. */
export async function completeSignIn(
  deps: OAuthDependencies,
  identity: VerifiedProviderIdentity,
  input: CompleteOAuthInput,
): Promise<OAuthOutcome> {
  const now = deps.clock.now();
  const existing = await deps.identities.findByProviderSubject(
    identity.provider,
    identity.providerUserId,
  );

  const colliding =
    identity.email === undefined ? undefined : await deps.users.findByEmail(identity.email);

  const decision = decideLinking({
    linkedUserId: existing?.userId ?? null,
    userWithSameEmail:
      colliding === undefined
        ? null
        : { id: colliding.id, emailVerified: colliding.emailVerifiedAt !== null },
    providerEmailVerified: identity.emailVerified,
    hasEmail: identity.email !== undefined,
  });

  switch (decision.action) {
    case 'refuse':
      return await fail(deps, input, decision.reason);

    case 'require_explicit_link':
      await deps.audit.record({
        action: 'identity.oauth.link_required',
        result: 'denied',
        actor: userActor(null),
        resourceType: 'user',
        resourceId: decision.existingUserId,
        ...(input.ip === undefined ? {} : { ip: input.ip }),
        metadata: { provider: identity.provider },
      });
      // No session, no merge. The account holder links from inside a session they can
      // already open, which is the only thing that proves they are the same person.
      return { outcome: 'link_required', email: identity.email ?? '' };

    case 'sign_in_existing': {
      if (existing !== undefined) await refreshIdentityRecord(deps, existing, identity, now);
      return await issueSession(deps, decision.userId, identity, input, false);
    }

    case 'create_user': {
      const userId = await createFederatedUser(deps, identity, input, now);
      return await issueSession(deps, userId, identity, input, true);
    }

    default: {
      const unreachable: never = decision;
      return unreachable;
    }
  }
}

/** Attaches a provider identity to an already-authenticated user. */
export async function completeLink(
  deps: OAuthDependencies,
  sessionUserId: string,
  identity: VerifiedProviderIdentity,
  input: CompleteOAuthInput,
): Promise<OAuthOutcome> {
  const now = deps.clock.now();
  const existing = await deps.identities.findByProviderSubject(
    identity.provider,
    identity.providerUserId,
  );
  const held = await deps.identities.listForUser(sessionUserId);

  const decision = decideExplicitLink({
    sessionUserId,
    linkedUserId: existing?.userId ?? null,
    userAlreadyHasProvider: held.some((i) => i.provider === identity.provider),
  });

  if (decision.action === 'refuse') {
    await deps.audit.record({
      action: 'identity.oauth.link_refused',
      result: 'denied',
      actor: userActor(sessionUserId),
      resourceType: 'user',
      resourceId: sessionUserId,
      ...(input.ip === undefined ? {} : { ip: input.ip }),
      metadata: { provider: identity.provider, reason: decision.reason },
    });
    return { outcome: 'failed', reason: decision.reason };
  }

  if (decision.action === 'already_linked_to_self') {
    return { outcome: 'already_linked', userId: sessionUserId };
  }

  await deps.identities.link({
    id: randomUUID(),
    userId: sessionUserId,
    provider: identity.provider,
    providerUserId: identity.providerUserId,
    email: identity.email,
    emailVerified: identity.emailVerified,
    at: now,
  });
  await deps.audit.record({
    action: 'identity.oauth.linked',
    result: 'succeeded',
    actor: userActor(sessionUserId),
    resourceType: 'user',
    resourceId: sessionUserId,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
    metadata: { provider: identity.provider },
  });
  return { outcome: 'linked', userId: sessionUserId };
}

/**
 * Issues a session for a federated sign-in.
 *
 * The account's own status still governs. A suspended user does not become signable-in by
 * arriving through a provider — federation establishes WHO, never WHETHER.
 *
 * MFA still applies too: if the account has a confirmed factor, the session is created
 * unsatisfied and the second factor is outstanding exactly as for a password sign-in. A
 * provider's assurance is not a substitute for the user's own second factor.
 */
async function issueSession(
  deps: OAuthDependencies,
  userId: string,
  identity: VerifiedProviderIdentity,
  input: CompleteOAuthInput,
  createdUser: boolean,
): Promise<OAuthOutcome> {
  const now = deps.clock.now();
  const user = await deps.users.findById(userId);
  if (user === undefined || user.status === 'suspended' || user.status === 'deactivated') {
    return await fail(deps, input, 'account_unavailable');
  }

  const started = startSession(now);
  const sessionId = randomUUID();
  await deps.sessions.create({
    id: sessionId,
    userId,
    tokenHash: started.tokenHash,
    expiresAt: started.expiresAt,
    absoluteExpiresAt: started.absoluteExpiresAt,
    mfaSatisfiedAt: user.mfaEnabled ? null : now,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
    ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
    ...(input.deviceLabel === undefined ? {} : { deviceLabel: input.deviceLabel }),
  });
  if (!user.mfaEnabled) await deps.users.markSignedIn(userId, now);

  await deps.audit.record({
    action: 'identity.oauth.signin_succeeded',
    result: 'succeeded',
    actor: userActor(userId),
    resourceType: 'session',
    resourceId: sessionId,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
    metadata: { provider: identity.provider, createdUser },
  });

  return {
    outcome: 'authenticated',
    userId,
    sessionId,
    token: started.token,
    expiresAt: started.expiresAt,
    createdUser,
  };
}

/**
 * Unlinks a provider.
 *
 * Refuses to remove the last way in. A user with no password whose only identity is Google
 * would be locked out permanently, and "I removed my own access" is not a recoverable state.
 */
export async function unlinkProvider(
  deps: OAuthDependencies,
  userId: string,
  provider: ProviderId,
): Promise<boolean> {
  const user = await deps.users.findById(userId);
  if (user === undefined) throw new ValidationError('Account not found.');

  const held = await deps.identities.listForUser(userId);
  const remaining = held.filter((i) => i.provider !== provider).length;
  if (user.passwordHash === null && remaining === 0) {
    throw new ValidationError(
      'Set a password before removing your last sign-in method, or you will be locked out.',
    );
  }

  const removed = await deps.identities.unlink(userId, provider);
  if (removed) {
    await deps.audit.record({
      action: 'identity.oauth.unlinked',
      result: 'succeeded',
      actor: userActor(userId),
      resourceType: 'user',
      resourceId: userId,
      metadata: { provider },
    });
  }
  return removed;
}
