/**
 * Sign-in, session lifecycle and revocation.
 *
 * Authentication only. It establishes WHO the actor is and never what they may do —
 * membership, roles, workspace access and RLS are all downstream of this file and none of
 * them are weakened by anything in it. A successful sign-in yields a session bound to a
 * user, not to a tenant; choosing an organization is a separate, authorised step.
 */

import { randomUUID } from 'node:crypto';
import {
  hashToken,
  renewedExpiry,
  requiresReauthentication,
  type SessionRecord,
  sessionState,
  startSession,
  verifyPassword,
} from '@growth-os/authn';
import {
  afterFailedAttempt,
  CLEARED_LOCKOUT,
  isLocked,
  normaliseEmail,
  refusalForStatus,
  type SignInRefusal,
} from '../domain/index.js';
import type {
  AuditSink,
  AuthRateLimiter,
  Clock,
  MfaRepository,
  SessionRecordRow,
  SessionRepository,
  UserRecord,
  UserRepository,
} from './ports.js';

export interface SignInDependencies {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly mfa: MfaRepository;
  readonly audit: AuditSink;
  readonly clock: Clock;
  readonly rateLimiter?: AuthRateLimiter | undefined;
}

export interface SignInInput {
  readonly email: string;
  readonly password: string;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly deviceLabel?: string | undefined;
}

export type SignInResult =
  | {
      readonly outcome: 'authenticated';
      readonly userId: string;
      readonly sessionId: string;
      readonly token: string;
      readonly expiresAt: Date;
    }
  | {
      /** Password accepted; a second factor is outstanding. The session exists but is not
       *  yet MFA-satisfied, so nothing sensitive can be done with it. */
      readonly outcome: 'mfa_required';
      readonly userId: string;
      readonly sessionId: string;
      readonly token: string;
      readonly expiresAt: Date;
    }
  | { readonly outcome: 'refused'; readonly reason: SignInRefusal }
  | { readonly outcome: 'rate_limited' };

/**
 * Creates the session row for a successful password check.
 *
 * Separated from `signIn` so the device metadata plumbing does not obscure the refusal
 * ordering above it, which is the part that carries the security property.
 */
async function openSession(
  deps: SignInDependencies,
  userId: string,
  input: SignInInput,
  now: Date,
  mfaOutstanding: boolean,
): Promise<{ sessionId: string; started: ReturnType<typeof startSession> }> {
  const started = startSession(now);
  const sessionId = randomUUID();
  await deps.sessions.create({
    id: sessionId,
    userId,
    tokenHash: started.tokenHash,
    expiresAt: started.expiresAt,
    absoluteExpiresAt: started.absoluteExpiresAt,
    // Null until the second factor is satisfied, so everything gated on re-authentication
    // refuses on this session until MFA completes.
    mfaSatisfiedAt: mfaOutstanding ? null : now,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
    ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
    ...(input.deviceLabel === undefined ? {} : { deviceLabel: input.deviceLabel }),
  });
  return { sessionId, started };
}

/**
 * Authenticates an email and password.
 *
 * THE INVARIANT THIS FUNCTION EXISTS TO HOLD: every refusal costs the same and says the
 * same thing. An unknown address still runs a full Argon2 verification (against a dummy
 * hash, inside verifyPassword), a locked account is not announced, and the caller receives a
 * `reason` it must NOT forward to the client. Any early return added below this line
 * reintroduces the timing oracle that the dummy hash exists to close.
 */
/**
 * The refusal half of sign-in.
 *
 * Every branch here has already paid for a full Argon2 verification, which is the point:
 * `passwordOk` is computed by the caller BEFORE any of these checks, so an unknown address,
 * a locked account and a wrong password all cost the same. Splitting the refusals out keeps
 * that ordering visible — an early return added here would reintroduce the timing oracle.
 */
async function refusalFor(
  deps: SignInDependencies,
  user: UserRecord,
  passwordOk: boolean,
  now: Date,
  ip: string | undefined,
): Promise<SignInRefusal | undefined> {
  // Checked AFTER the password verification so response time does not reveal that an
  // account is locked — which would otherwise confirm the address exists.
  if (isLocked({ failedLoginCount: user.failedLoginCount, lockedUntil: user.lockedUntil }, now)) {
    await recordFailure(deps, user.id, ip, 'locked');
    return 'locked';
  }

  if (!passwordOk) {
    const next = afterFailedAttempt(
      { failedLoginCount: user.failedLoginCount, lockedUntil: user.lockedUntil },
      now,
    );
    await deps.users.updateLockout(user.id, {
      failedLoginCount: next.failedLoginCount,
      lockedUntil: next.lockedUntil,
    });
    await recordFailure(deps, user.id, ip, 'bad_password');
    return 'bad_password';
  }

  const statusRefusal = refusalForStatus(user.status);
  if (statusRefusal !== undefined) {
    await recordFailure(deps, user.id, ip, statusRefusal);
    return statusRefusal;
  }

  return undefined;
}

/** Whether a second factor is still outstanding for this user. */
async function mfaOutstandingFor(deps: SignInDependencies, user: UserRecord): Promise<boolean> {
  if (!user.mfaEnabled) return false;
  const credential = await deps.mfa.findTotpForUser(user.id);
  // An UNCONFIRMED credential cannot gate a sign-in: otherwise a half-finished enrolment
  // locks the user out of their own account with no way back in.
  return credential?.confirmedAt !== null && credential !== undefined;
}

/**
 * Authenticates an email and password.
 *
 * THE INVARIANT THIS FUNCTION EXISTS TO HOLD: every refusal costs the same and says the
 * same thing. An unknown address still runs a full Argon2 verification (against a dummy
 * hash, inside verifyPassword), a locked account is not announced, and the caller receives a
 * `reason` it must NOT forward to the client.
 */
export async function signIn(deps: SignInDependencies, input: SignInInput): Promise<SignInResult> {
  const now = deps.clock.now();
  const email = normaliseEmail(input.email);

  // Per-source limiting, distinct from per-account lockout. Lockout stops one account being
  // guessed; this stops one source spraying one common password across many accounts, which
  // lockout never sees because each account only ever fails once.
  if (deps.rateLimiter !== undefined) {
    const allowed = await deps.rateLimiter.consume(`signin:${input.ip ?? 'unknown'}`);
    if (!allowed) return { outcome: 'rate_limited' };
  }

  const user = await deps.users.findByEmail(email);

  // Deliberately NOT behind an `if (user)`. verifyPassword(null, ...) verifies a dummy hash
  // so an unknown address costs the same as a known one.
  const passwordOk = await verifyPassword(user?.passwordHash ?? null, input.password);

  if (user === undefined) {
    await deps.audit.record({
      action: 'identity.signin.failed',
      actorUserId: null,
      resourceType: 'user',
      resourceId: 'unknown',
      ...(input.ip === undefined ? {} : { ip: input.ip }),
      metadata: { reason: 'unknown_user', email },
    });
    return { outcome: 'refused', reason: 'unknown_user' };
  }

  const refusal = await refusalFor(deps, user, passwordOk, now, input.ip);
  if (refusal !== undefined) return { outcome: 'refused', reason: refusal };

  // The password was right, so the lockout counter resets even when MFA is still outstanding
  // — otherwise a user who fumbles their authenticator locks themselves out of an account
  // whose password they demonstrably know.
  await deps.users.updateLockout(user.id, CLEARED_LOCKOUT);

  const mfaOutstanding = await mfaOutstandingFor(deps, user);
  const { sessionId, started } = await openSession(deps, user.id, input, now, mfaOutstanding);

  if (!mfaOutstanding) await deps.users.markSignedIn(user.id, now);

  await deps.audit.record({
    action: mfaOutstanding ? 'identity.signin.mfa_pending' : 'identity.signin.succeeded',
    actorUserId: user.id,
    resourceType: 'session',
    resourceId: sessionId,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });

  return {
    outcome: mfaOutstanding ? 'mfa_required' : 'authenticated',
    userId: user.id,
    sessionId,
    token: started.token,
    expiresAt: started.expiresAt,
  };
}

async function recordFailure(
  deps: SignInDependencies,
  userId: string,
  ip: string | undefined,
  reason: SignInRefusal,
): Promise<void> {
  await deps.audit.record({
    action: 'identity.signin.failed',
    actorUserId: userId,
    resourceType: 'user',
    resourceId: userId,
    ...(ip === undefined ? {} : { ip }),
    metadata: { reason },
  });
}

export interface AuthenticatedSession {
  readonly session: SessionRecordRow;
  readonly user: { readonly id: string; readonly mfaEnabled: boolean };
  /** False while a second factor is outstanding. */
  readonly mfaSatisfied: boolean;
  /** True when a sensitive action must re-authenticate first. */
  readonly needsReauthentication: boolean;
}

export type SessionLookup =
  | { readonly ok: true; readonly value: AuthenticatedSession }
  | { readonly ok: false; readonly reason: 'not_found' | 'expired' | 'revoked' | 'user_invalid' };

/**
 * Resolves a presented session token.
 *
 * Runs on every authenticated request, so it is also where a revocation takes effect. The
 * token is looked up by its HASH — the raw value is never stored, so a database leak yields
 * nothing presentable.
 */
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
  const now = deps.clock.now();
  await deps.sessions.revoke(sessionId, now, 'signed_out');
  await deps.audit.record({
    action: 'identity.signout',
    actorUserId,
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
  const now = deps.clock.now();
  const revoked = await deps.sessions.revokeAllForUser(
    userId,
    now,
    'signed_out_everywhere',
    exceptSessionId,
  );
  await deps.audit.record({
    action: 'identity.signout_everywhere',
    actorUserId: userId,
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
