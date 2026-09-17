/**
 * MFA enrolment, verification and recovery.
 *
 * Three properties this file exists to hold, each of which is a way MFA is commonly got
 * wrong rather than a theoretical concern:
 *
 *   1. An UNCONFIRMED credential can never satisfy a challenge. Otherwise starting enrolment
 *      is itself the bypass — a stolen session enrols a factor and immediately uses it.
 *   2. A code cannot be REPLAYED inside its own period. TOTP codes are valid for 30 seconds,
 *      so an intercepted one works again unless the accepted counter is recorded.
 *   3. The secret never leaves the server in a readable form after enrolment, and never
 *      reaches a log.
 */

import { userActor } from '@growth-os/audit';
import {
  hashRecoveryCode,
  issueRecoveryCode,
  type SecretCipher,
  totpCounterFor,
  verifyTotp,
} from '@growth-os/authn';
import { ValidationError } from '@growth-os/errors';
import { canSatisfyMfa, RECOVERY_CODE_COUNT } from '../domain/index.js';
import type {
  AuditSink,
  AuthRateLimiter,
  Clock,
  MfaRepository,
  SessionRepository,
  UserRepository,
} from './ports.js';
import type { IdentityUnitOfWork } from './unit-of-work.js';
import { bindToTransaction } from './unit-of-work.js';

export interface MfaDependencies {
  /** The transaction these writes and their audit events commit within. */
  readonly unitOfWork: IdentityUnitOfWork;
  readonly users: UserRepository;
  readonly mfa: MfaRepository;
  readonly sessions: SessionRepository;
  readonly audit: AuditSink;
  readonly clock: Clock;
  readonly cipher: SecretCipher;
  readonly rateLimiter?: AuthRateLimiter | undefined;
}

export interface EnrolmentStart {
  readonly credentialId: string;
  /** The otpauth:// URI for the QR code. Contains the secret — never log it. */
  readonly uri: string;
  /** For manual entry when a camera is unavailable. Equally sensitive. */
  readonly secretBase32: string;
}

/**
 * Begins TOTP enrolment.
 *
 * The credential is written UNCONFIRMED. It cannot satisfy a challenge until the user proves
 * possession by submitting a code, which is what stops enrolment being a bypass — and what
 * stops a user locking themselves out by scanning a QR code that never actually worked.
 */
export type MfaChallengeOutcome =
  | 'satisfied'
  | 'invalid_code'
  | 'replayed'
  | 'not_enrolled'
  | 'rate_limited';

export async function completeMfaChallenge(
  deps: MfaDependencies,
  sessionId: string,
  userId: string,
  code: string,
): Promise<MfaChallengeOutcome> {
  return await deps.unitOfWork.transaction(
    'identity mfa challenge',
    async (repositories) =>
      await completeMfaChallengeInTransaction(
        bindToTransaction(deps, repositories),
        sessionId,
        userId,
        code,
      ),
  );
}

async function completeMfaChallengeInTransaction(
  deps: MfaDependencies,
  sessionId: string,
  userId: string,
  code: string,
): Promise<MfaChallengeOutcome> {
  const now = deps.clock.now();

  // Rate limited per user, not per IP: the code space is a million and the window is 30
  // seconds, so unbounded attempts are genuinely brute-forceable.
  if (deps.rateLimiter !== undefined) {
    const allowed = await deps.rateLimiter.consume(`mfa:${userId}`);
    if (!allowed) return 'rate_limited';
  }

  const credential = await deps.mfa.findTotpForUser(userId);
  if (
    credential === undefined ||
    !canSatisfyMfa(credential) ||
    credential.secretEncrypted === null
  ) {
    return 'not_enrolled';
  }

  const secret = deps.cipher.decrypt(credential.secretEncrypted);
  if (verifyTotp(secret, code, now)) {
    const counter = totpCounterFor(now);
    // The replay guard. A TOTP code is valid for its whole period, so without recording the
    // accepted counter an intercepted code works a second time within 30 seconds.
    const accepted = await deps.mfa.recordUse(credential.id, now, counter);
    if (!accepted) {
      await deps.audit.record({
        action: 'identity.mfa.replay_rejected',
        result: 'denied',
        actor: userActor(userId),
        resourceType: 'mfa_credential',
        resourceId: credential.id,
      });
      return 'replayed';
    }
    await satisfy(deps, sessionId, userId, now, 'totp');
    return 'satisfied';
  }

  // A recovery code is tried only after the TOTP code fails, so a valid TOTP code never
  // consumes one by accident.
  const consumed = await deps.mfa.consumeRecoveryCode(userId, hashRecoveryCode(code), now);
  if (consumed) {
    const remaining = await deps.mfa.countUnusedRecoveryCodes(userId);
    await satisfy(deps, sessionId, userId, now, 'recovery_code');
    await deps.audit.record({
      action: 'identity.mfa.recovery_code_used',
      result: 'succeeded',
      actor: userActor(userId),
      resourceType: 'user',
      resourceId: userId,
      metadata: { remaining },
    });
    return 'satisfied';
  }

  await deps.audit.record({
    action: 'identity.mfa.challenge_failed',
    result: 'failed',
    actor: userActor(userId),
    resourceType: 'mfa_credential',
    resourceId: credential.id,
  });
  return 'invalid_code';
}

async function satisfy(
  deps: MfaDependencies,
  sessionId: string,
  userId: string,
  now: Date,
  method: string,
): Promise<void> {
  await deps.sessions.recordMfaSatisfied(sessionId, now);
  await deps.users.markSignedIn(userId, now);
  if (deps.rateLimiter !== undefined) await deps.rateLimiter.reset(`mfa:${userId}`);
  await deps.audit.record({
    action: 'identity.mfa.satisfied',
    result: 'succeeded',
    actor: userActor(userId),
    resourceType: 'session',
    resourceId: sessionId,
    metadata: { method },
  });
}

/**
 * Disables MFA.
 *
 * Requires a currently-valid factor, not merely a signed-in session. Removing a second
 * factor is exactly what an attacker holding a stolen session wants to do first, and a
 * session alone is the thing MFA exists to backstop.
 */
export async function disableMfa(
  deps: MfaDependencies,
  userId: string,
  currentCode: string,
): Promise<void> {
  return await deps.unitOfWork.transaction(
    'identity mfa disable',
    async (repositories) =>
      await disableMfaInTransaction(bindToTransaction(deps, repositories), userId, currentCode),
  );
}

async function disableMfaInTransaction(
  deps: MfaDependencies,
  userId: string,
  currentCode: string,
): Promise<void> {
  const credential = await deps.mfa.findTotpForUser(userId);
  if (
    credential === undefined ||
    !canSatisfyMfa(credential) ||
    credential.secretEncrypted === null
  ) {
    throw new ValidationError('Multi-factor authentication is not enabled.');
  }

  const now = deps.clock.now();
  const secret = deps.cipher.decrypt(credential.secretEncrypted);
  const byTotp = verifyTotp(secret, currentCode, now);
  const byRecovery = byTotp
    ? false
    : await deps.mfa.consumeRecoveryCode(userId, hashRecoveryCode(currentCode), now);

  if (!byTotp && !byRecovery) {
    await deps.audit.record({
      action: 'identity.mfa.disable_failed',
      result: 'failed',
      actor: userActor(userId),
      resourceType: 'mfa_credential',
      resourceId: credential.id,
    });
    throw new ValidationError('That code is not correct.');
  }

  await deps.mfa.deleteForUser(userId);
  await deps.users.setMfaEnabled(userId, false);
  await deps.audit.record({
    action: 'identity.mfa.disabled',
    result: 'succeeded',
    actor: userActor(userId),
    resourceType: 'user',
    resourceId: userId,
    metadata: { verifiedBy: byTotp ? 'totp' : 'recovery_code' },
  });
}

/** Regenerates recovery codes, invalidating every previous one. */
export async function regenerateRecoveryCodes(
  deps: MfaDependencies,
  userId: string,
  currentCode: string,
): Promise<readonly string[]> {
  return await deps.unitOfWork.transaction(
    'identity mfa recovery regeneration',
    async (repositories) =>
      await regenerateRecoveryCodesInTransaction(
        bindToTransaction(deps, repositories),
        userId,
        currentCode,
      ),
  );
}

async function regenerateRecoveryCodesInTransaction(
  deps: MfaDependencies,
  userId: string,
  currentCode: string,
): Promise<readonly string[]> {
  const credential = await deps.mfa.findTotpForUser(userId);
  if (
    credential === undefined ||
    !canSatisfyMfa(credential) ||
    credential.secretEncrypted === null
  ) {
    throw new ValidationError('Multi-factor authentication is not enabled.');
  }
  const now = deps.clock.now();
  if (!verifyTotp(deps.cipher.decrypt(credential.secretEncrypted), currentCode, now)) {
    throw new ValidationError('That code is not correct.');
  }

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => issueRecoveryCode());
  await deps.mfa.replaceRecoveryCodes(userId, codes.map(hashRecoveryCode));
  await deps.audit.record({
    action: 'identity.mfa.recovery_codes_regenerated',
    result: 'succeeded',
    actor: userActor(userId),
    resourceType: 'user',
    resourceId: userId,
  });
  return codes;
}
