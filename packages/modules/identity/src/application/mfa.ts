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

import { randomUUID } from 'node:crypto';
import {
  generateTotpSecret,
  hashRecoveryCode,
  issueRecoveryCode,
  type SecretCipher,
  totpCounterFor,
  totpUri,
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

export interface MfaDependencies {
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
export async function startTotpEnrolment(
  deps: MfaDependencies,
  userId: string,
  accountName: string,
  issuer = 'Growth OS',
): Promise<EnrolmentStart> {
  const existing = await deps.mfa.findTotpForUser(userId);
  if (existing !== undefined && canSatisfyMfa(existing)) {
    throw new ValidationError('Multi-factor authentication is already enabled.');
  }

  // Any previous half-finished attempt is discarded, so a user cannot end up with two
  // credentials and no idea which authenticator entry is live.
  if (existing !== undefined) await deps.mfa.deleteForUser(userId);

  const secret = generateTotpSecret();
  const credentialId = randomUUID();
  await deps.mfa.createTotp({
    id: credentialId,
    userId,
    // Encrypted at rest with the application key, which is not in the database. A dump
    // yields ciphertext only.
    secretEncrypted: deps.cipher.encrypt(secret),
  });

  await deps.audit.record({
    action: 'identity.mfa.enrolment_started',
    actorUserId: userId,
    resourceType: 'mfa_credential',
    resourceId: credentialId,
    // No secret, no URI. Both would put the factor in the audit log.
  });

  return {
    credentialId,
    uri: totpUri({ secret, accountName, issuer }),
    secretBase32: totpUri({ secret, accountName, issuer }).match(/secret=([A-Z2-7]+)/)?.[1] ?? '',
  };
}

export interface ConfirmEnrolmentResult {
  /** Shown once. Only their hashes are stored. */
  readonly recoveryCodes: readonly string[];
}

/**
 * Confirms enrolment with a code from the authenticator.
 *
 * Recovery codes are issued only here, on confirmation — never at `start`. Issuing them
 * earlier would hand out a working second factor to someone who never proved they can
 * generate one, which is the same bypass in a different shape.
 */
export async function confirmTotpEnrolment(
  deps: MfaDependencies,
  userId: string,
  code: string,
): Promise<ConfirmEnrolmentResult> {
  const credential = await deps.mfa.findTotpForUser(userId);
  if (credential === undefined || credential.secretEncrypted === null) {
    throw new ValidationError('Start multi-factor enrolment before confirming it.');
  }
  if (canSatisfyMfa(credential)) {
    throw new ValidationError('Multi-factor authentication is already enabled.');
  }

  const now = deps.clock.now();
  const secret = deps.cipher.decrypt(credential.secretEncrypted);
  if (!verifyTotp(secret, code, now)) {
    await deps.audit.record({
      action: 'identity.mfa.enrolment_failed',
      actorUserId: userId,
      resourceType: 'mfa_credential',
      resourceId: credential.id,
    });
    throw new ValidationError('That code is not correct. Check your authenticator and try again.');
  }

  await deps.mfa.confirm(credential.id, now, totpCounterFor(now));
  await deps.users.setMfaEnabled(userId, true);

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => issueRecoveryCode());
  await deps.mfa.replaceRecoveryCodes(userId, codes.map(hashRecoveryCode));

  await deps.audit.record({
    action: 'identity.mfa.enabled',
    actorUserId: userId,
    resourceType: 'mfa_credential',
    resourceId: credential.id,
    metadata: { recoveryCodesIssued: codes.length },
  });

  return { recoveryCodes: codes };
}

export type MfaChallengeOutcome =
  | 'satisfied'
  | 'invalid_code'
  | 'replayed'
  | 'not_enrolled'
  | 'rate_limited';

/**
 * Completes an outstanding second factor for a session.
 *
 * Accepts a TOTP code or a recovery code; both mark the session MFA-satisfied, and a
 * recovery code is consumed in the process.
 */
export async function completeMfaChallenge(
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
        actorUserId: userId,
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
      actorUserId: userId,
      resourceType: 'user',
      resourceId: userId,
      metadata: { remaining },
    });
    return 'satisfied';
  }

  await deps.audit.record({
    action: 'identity.mfa.challenge_failed',
    actorUserId: userId,
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
    actorUserId: userId,
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
      actorUserId: userId,
      resourceType: 'mfa_credential',
      resourceId: credential.id,
    });
    throw new ValidationError('That code is not correct.');
  }

  await deps.mfa.deleteForUser(userId);
  await deps.users.setMfaEnabled(userId, false);
  await deps.audit.record({
    action: 'identity.mfa.disabled',
    actorUserId: userId,
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
    actorUserId: userId,
    resourceType: 'user',
    resourceId: userId,
  });
  return codes;
}
