/**
 * TOTP enrolment.
 *
 * Split from the challenge and disable paths purely for length; enrolment is the lifecycle
 * that turns MFA ON, and its two steps are deliberately separate — an unconfirmed credential
 * cannot satisfy a challenge, so a user who abandons setup is never locked out by it.
 */

import { randomUUID } from 'node:crypto';
import { userActor } from '@growth-os/audit';
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
export async function startTotpEnrolment(
  deps: MfaDependencies,
  userId: string,
  accountName: string,
  issuer = 'Growth OS',
): Promise<EnrolmentStart> {
  return await deps.unitOfWork.transaction(
    'identity mfa enrolment start',
    async (repositories) =>
      await startTotpEnrolmentInTransaction(
        bindToTransaction(deps, repositories),
        userId,
        accountName,
        issuer,
      ),
  );
}

async function startTotpEnrolmentInTransaction(
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
    result: 'succeeded',
    actor: userActor(userId),
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
  return await deps.unitOfWork.transaction(
    'identity mfa enrolment confirm',
    async (repositories) =>
      await confirmTotpEnrolmentInTransaction(bindToTransaction(deps, repositories), userId, code),
  );
}

async function confirmTotpEnrolmentInTransaction(
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
      result: 'failed',
      actor: userActor(userId),
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
    result: 'succeeded',
    actor: userActor(userId),
    resourceType: 'mfa_credential',
    resourceId: credential.id,
    metadata: { recoveryCodesIssued: codes.length },
  });

  return { recoveryCodes: codes };
}

/**
 * Completes an outstanding second factor for a session.
 *
 * Accepts a TOTP code or a recovery code; both mark the session MFA-satisfied, and a
 * recovery code is consumed in the process.
 */
