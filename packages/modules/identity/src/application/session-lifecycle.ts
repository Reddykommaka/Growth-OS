/**
 * The session lifecycle AFTER authentication.
 *
 * Presenting a session token, revoking one, revoking them all, listing devices. Split from
 * the credential check for length, and the seam is a real one: nothing here verifies a
 * password, and `authenticateSession` is a READ path whose one incidental write
 * (`sessions.touch`) is a single atomic statement — which is why it takes no unit of work.
 */

import { userActor } from '@growth-os/audit';
import {
  hashToken,
  renewedExpiry,
  requiresReauthentication,
  type SessionRecord,
  sessionState,
} from '@growth-os/authn';
import type { SessionRecordRow } from './ports.js';
import type { SessionLookup, SignInDependencies } from './sign-in.js';
import { bindToTransaction } from './unit-of-work.js';

export async function authenticateSession(
  deps: SignInDependencies,
  token: string,
): Promise<SessionLookup> {
  const now = deps.clock.now();
  const row = await deps.sessions.findByTokenHash(hashToken(token));
  if (row === undefined) return { ok: false, reason: 'not_found' };

  const record: SessionRecord = {
    expiresAt: row.expiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    revokedAt: row.revokedAt,
    mfaSatisfiedAt: row.mfaSatisfiedAt,
    impersonationExpiresAt: row.impersonationExpiresAt,
  };

  const state = sessionState(record, now);
  if (state === 'revoked') return { ok: false, reason: 'revoked' };
  if (state !== 'active') return { ok: false, reason: 'expired' };

  const user = await deps.users.findById(row.userId);
  // A suspended or deleted user's live sessions must stop working immediately, without
  // anyone having to remember to revoke them one by one.
  if (user === undefined || user.status === 'suspended' || user.status === 'deactivated') {
    return { ok: false, reason: 'user_invalid' };
  }

  // Sliding renewal, rate-limited so an active session is not one write per request.
  const renewed = renewedExpiry(record, now);
  await deps.sessions.touch(row.id, now, renewed);

  return {
    ok: true,
    value: {
      session: row,
      user: { id: user.id, mfaEnabled: user.mfaEnabled },
      mfaSatisfied: row.mfaSatisfiedAt !== null,
      needsReauthentication: requiresReauthentication(record, now),
    },
  };
}

export async function signOut(
  deps: SignInDependencies,
  sessionId: string,
  actorUserId: string,
  ip?: string,
): Promise<void> {
  return await deps.unitOfWork.transaction(
    'identity sign-out',
    async (repositories) =>
      await signOutInTransaction(bindToTransaction(deps, repositories), sessionId, actorUserId, ip),
  );
}

async function signOutInTransaction(
  deps: SignInDependencies,
  sessionId: string,
  actorUserId: string,
  ip?: string,
): Promise<void> {
  const now = deps.clock.now();
  await deps.sessions.revoke(sessionId, now, 'signed_out');
  await deps.audit.record({
    action: 'identity.signout',
    result: 'succeeded',
    actor: userActor(actorUserId),
    resourceType: 'session',
    resourceId: sessionId,
    ...(ip === undefined ? {} : { ip }),
  });
}

/** Signs out everywhere — the control a user reaches for when a device is lost. */
export async function signOutEverywhere(
  deps: SignInDependencies,
  userId: string,
  exceptSessionId?: string,
  ip?: string,
): Promise<number> {
  return await deps.unitOfWork.transaction(
    'identity sign-out everywhere',
    async (repositories) =>
      await signOutEverywhereInTransaction(
        bindToTransaction(deps, repositories),
        userId,
        exceptSessionId,
        ip,
      ),
  );
}

async function signOutEverywhereInTransaction(
  deps: SignInDependencies,
  userId: string,
  exceptSessionId?: string,
  ip?: string,
): Promise<number> {
  const now = deps.clock.now();
  const revoked = await deps.sessions.revokeAllForUser(
    userId,
    now,
    'signed_out_everywhere',
    exceptSessionId,
  );
  await deps.audit.record({
    action: 'identity.signout_everywhere',
    result: 'succeeded',
    actor: userActor(userId),
    resourceType: 'user',
    resourceId: userId,
    ...(ip === undefined ? {} : { ip }),
    metadata: { sessionsRevoked: revoked },
  });
  return revoked;
}

/** The device list. Returns metadata only — never a token or its hash. */
export async function listSessions(
  deps: SignInDependencies,
  userId: string,
): Promise<SessionRecordRow[]> {
  return await deps.sessions.listForUser(userId);
}
