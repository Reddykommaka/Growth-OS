/**
 * Registration, email verification and the password lifecycle.
 *
 * The recurring rule in this file: a caller who is not signed in learns NOTHING about which
 * addresses have accounts. Registration and password reset both take an email and both
 * return the same shape whether or not the account exists, because the alternative is an
 * endpoint that enumerates the customer base for free.
 */

import { randomUUID } from 'node:crypto';
import { hashPassword, hashToken, issueToken, verifyPassword } from '@growth-os/authn';
import { ConflictError, ValidationError } from '@growth-os/errors';
import {
  isPlausibleEmail,
  normaliseEmail,
  tokenTtlMs,
  type UserTokenPurpose,
} from '../domain/index.js';
import type {
  AuditSink,
  Clock,
  SessionRepository,
  UserRepository,
  UserTokenRepository,
} from './ports.js';

export interface RegistrationDependencies {
  readonly users: UserRepository;
  readonly tokens: UserTokenRepository;
  readonly sessions: SessionRepository;
  readonly audit: AuditSink;
  readonly clock: Clock;
}

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly name?: string | undefined;
  readonly ip?: string | undefined;
}

export interface RegisterResult {
  readonly userId: string;
  /**
   * The verification token, for the caller to email. Never logged, never returned over HTTP.
   *
   * It is returned here rather than emailed inside this service so that delivery is the
   * caller's concern and this stays testable — but the type name and this comment are the
   * only things stopping it being handed to a client, so the API layer must treat it as a
   * secret.
   */
  readonly verificationToken: string;
  readonly expiresAt: Date;
}

/**
 * Registers a user.
 *
 * Throws ConflictError for a duplicate address. That IS an enumeration vector, and it is a
 * deliberate, bounded one: a sign-up form that silently succeeds for an existing address
 * cannot tell the real owner anything useful, and every product in this category discloses
 * it. The mitigation is rate limiting on the endpoint, not a lie in the response — a lie
 * here means a user who already has an account gets a "check your email" that never arrives.
 */
export async function register(
  deps: RegistrationDependencies,
  input: RegisterInput,
): Promise<RegisterResult> {
  const email = normaliseEmail(input.email);
  if (!isPlausibleEmail(email)) {
    throw new ValidationError('Enter a valid email address.');
  }

  const existing = await deps.users.findByEmail(email);
  if (existing !== undefined) {
    throw new ConflictError('An account with that email address already exists.');
  }

  // Hashing happens before the insert so a policy rejection (too short, breached) costs no
  // database write, and so the plaintext lives for as short a time as possible.
  const passwordHash = await hashPassword(input.password);

  const userId = randomUUID();
  await deps.users.create({
    id: userId,
    email,
    passwordHash,
    ...(input.name === undefined ? {} : { name: input.name }),
    status: 'pending_verification',
  });

  const { verificationToken, expiresAt } = await issueVerificationToken(deps, userId);

  await deps.audit.record({
    action: 'identity.user.registered',
    actorUserId: userId,
    resourceType: 'user',
    resourceId: userId,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
    // No token, no password, no hash. The audit log is read by support.
    metadata: { email },
  });

  return { userId, verificationToken, expiresAt };
}

async function issueVerificationToken(
  deps: RegistrationDependencies,
  userId: string,
): Promise<{ verificationToken: string; expiresAt: Date }> {
  const now = deps.clock.now();
  const { token, tokenHash } = issueToken();
  const expiresAt = new Date(now.getTime() + tokenTtlMs('email_verification'));
  await deps.tokens.create({
    id: randomUUID(),
    userId,
    purpose: 'email_verification',
    tokenHash,
    expiresAt,
  });
  return { verificationToken: token, expiresAt };
}

/**
 * Re-issues a verification email.
 *
 * Invalidates the outstanding tokens first, so a user who requests three emails cannot leave
 * three live tokens behind — each one an independent chance for an intercepted message to be
 * replayed weeks later.
 */
export async function resendVerification(
  deps: RegistrationDependencies,
  userId: string,
): Promise<{ verificationToken: string; expiresAt: Date }> {
  await deps.tokens.invalidateAllFor(userId, 'email_verification', deps.clock.now());
  return await issueVerificationToken(deps, userId);
}

export type VerificationOutcome = 'verified' | 'invalid' | 'expired' | 'already_used';

/**
 * Verifies an email address.
 *
 * Single-use is decided by the conditional UPDATE in `consume`, not by the read above it:
 * two requests presenting the same token concurrently would both pass a read-then-write
 * check, and the second one must lose.
 */
export async function verifyEmail(
  deps: RegistrationDependencies,
  token: string,
  ip?: string,
): Promise<VerificationOutcome> {
  const now = deps.clock.now();
  const row = await deps.tokens.findUnconsumed('email_verification', hashToken(token));

  // Same outcome for "no such token" and "already consumed": distinguishing them tells a
  // holder of an intercepted token whether it was used, which is information they can act on.
  if (row === undefined) return 'invalid';
  if (row.expiresAt <= now) return 'expired';

  const won = await deps.tokens.consume(row.id, now);
  if (!won) return 'already_used';

  await deps.users.markEmailVerified(row.userId, now);
  await deps.audit.record({
    action: 'identity.email.verified',
    actorUserId: row.userId,
    resourceType: 'user',
    resourceId: row.userId,
    ...(ip === undefined ? {} : { ip }),
  });
  return 'verified';
}

export interface PasswordResetRequest {
  readonly email: string;
  readonly ip?: string | undefined;
}

/**
 * Starts a password reset.
 *
 * Returns undefined for an unknown address — and the caller MUST respond identically either
 * way. Unlike registration, there is no product reason to disclose here: the honest response
 * is "if that address has an account, we have emailed it", which is both true and silent.
 */
export async function requestPasswordReset(
  deps: RegistrationDependencies,
  input: PasswordResetRequest,
): Promise<{ token: string; expiresAt: Date; userId: string } | undefined> {
  const email = normaliseEmail(input.email);
  const user = await deps.users.findByEmail(email);
  if (user === undefined) return undefined;

  const now = deps.clock.now();
  await deps.tokens.invalidateAllFor(user.id, 'password_reset', now);

  const { token, tokenHash } = issueToken();
  const expiresAt = new Date(now.getTime() + tokenTtlMs('password_reset'));
  await deps.tokens.create({
    id: randomUUID(),
    userId: user.id,
    purpose: 'password_reset',
    tokenHash,
    expiresAt,
  });

  await deps.audit.record({
    action: 'identity.password.reset_requested',
    actorUserId: user.id,
    resourceType: 'user',
    resourceId: user.id,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });

  return { token, expiresAt, userId: user.id };
}

export type PasswordResetOutcome = 'reset' | 'invalid' | 'expired' | 'already_used';

/**
 * Completes a password reset.
 *
 * Every other session is revoked on success. A reset is what someone does when they believe
 * their account is compromised, so leaving the attacker's session alive would defeat the
 * entire exercise — and the user has no way to know it is still there.
 */
export async function completePasswordReset(
  deps: RegistrationDependencies,
  token: string,
  newPassword: string,
  ip?: string,
): Promise<PasswordResetOutcome> {
  const now = deps.clock.now();
  const row = await deps.tokens.findUnconsumed('password_reset', hashToken(token));
  if (row === undefined) return 'invalid';
  if (row.expiresAt <= now) return 'expired';

  // Hash before consuming: if the new password fails policy, the token must survive so the
  // user can try again rather than having to request a second email.
  const passwordHash = await hashPassword(newPassword);

  const won = await deps.tokens.consume(row.id, now);
  if (!won) return 'already_used';

  await deps.users.setPasswordHash(row.userId, passwordHash);
  await deps.users.updateLockout(row.userId, { failedLoginCount: 0, lockedUntil: null });
  const revoked = await deps.sessions.revokeAllForUser(row.userId, now, 'password_reset');

  await deps.audit.record({
    action: 'identity.password.reset_completed',
    actorUserId: row.userId,
    resourceType: 'user',
    resourceId: row.userId,
    ...(ip === undefined ? {} : { ip }),
    metadata: { sessionsRevoked: revoked },
  });
  return 'reset';
}

export interface ChangePasswordInput {
  readonly userId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
  /** Kept alive so the user is not signed out of the device they are using. */
  readonly currentSessionId?: string | undefined;
  readonly ip?: string | undefined;
}

/**
 * Changes a password for a signed-in user.
 *
 * Requires the current password even though the session already proves identity: a session
 * can be stolen, and this is the check that stops a stolen one being upgraded into permanent
 * account ownership.
 */
export async function changePassword(
  deps: RegistrationDependencies,
  input: ChangePasswordInput,
): Promise<void> {
  const user = await deps.users.findById(input.userId);
  if (user === undefined) throw new ValidationError('Account not found.');

  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw new ValidationError('The current password is incorrect.');
  }

  const passwordHash = await hashPassword(input.newPassword);
  const now = deps.clock.now();
  await deps.users.setPasswordHash(user.id, passwordHash);
  const revoked = await deps.sessions.revokeAllForUser(
    user.id,
    now,
    'password_changed',
    input.currentSessionId,
  );

  await deps.audit.record({
    action: 'identity.password.changed',
    actorUserId: user.id,
    resourceType: 'user',
    resourceId: user.id,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
    metadata: { otherSessionsRevoked: revoked },
  });
}

export type { UserTokenPurpose };
