/**
 * Identity domain rules.
 *
 * Pure: no database, no clock, no I/O. Everything here is a decision that can be made from
 * values alone, which is what makes the lockout and status rules exhaustively testable
 * without a server — and what stops them being reimplemented slightly differently at each
 * call site.
 */

export type UserStatus = 'pending_verification' | 'active' | 'suspended' | 'deactivated';

/**
 * Why a sign-in attempt was refused.
 *
 * Carried internally so the reason reaches the audit log and the logs. It must NOT reach the
 * caller: "this account is locked" and "wrong password" answer different questions, and
 * answering the first one confirms the account exists.
 */
export type SignInRefusal =
  | 'unknown_user'
  | 'bad_password'
  | 'locked'
  | 'suspended'
  | 'deactivated'
  | 'email_unverified'
  | 'mfa_required';

/** Lockout policy (06-identity-and-access.md §2). */
export interface LockoutPolicy {
  readonly threshold: number;
  readonly lockDurationMs: number;
}

/**
 * Five attempts, fifteen minutes.
 *
 * The threshold is a trade, not a constant of nature: too low and a shared office IP locks a
 * legitimate user out by accident; too high and it stops being a control. Five with a
 * fifteen-minute lock makes online guessing worthless (roughly 20 guesses an hour) while
 * staying under the number of times someone mistypes a password they actually know.
 */
export const DEFAULT_LOCKOUT_POLICY: LockoutPolicy = {
  threshold: 5,
  lockDurationMs: 15 * 60 * 1000,
};

export interface LockoutState {
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
}

export function isLocked(state: LockoutState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil > now;
}

/**
 * The lockout state after a failed attempt.
 *
 * The counter lives in Postgres rather than in the cache deliberately: an attacker who can
 * evict the cache must not be able to reset the count with it.
 */
export function afterFailedAttempt(
  state: LockoutState,
  now: Date,
  policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
): LockoutState {
  const failedLoginCount = state.failedLoginCount + 1;
  if (failedLoginCount < policy.threshold) {
    return { failedLoginCount, lockedUntil: state.lockedUntil };
  }
  return { failedLoginCount, lockedUntil: new Date(now.getTime() + policy.lockDurationMs) };
}

/** Clears the counter. Applied only after a fully successful sign-in, MFA included. */
export const CLEARED_LOCKOUT: LockoutState = { failedLoginCount: 0, lockedUntil: null };

/**
 * Whether a user in this state may start a session.
 *
 * Returns the refusal rather than a boolean so the caller records WHY without re-deriving
 * it, and so a new status cannot be added without deciding what it means here.
 */
export function refusalForStatus(status: UserStatus): SignInRefusal | undefined {
  switch (status) {
    case 'active':
      return undefined;
    case 'pending_verification':
      return 'email_unverified';
    case 'suspended':
      return 'suspended';
    case 'deactivated':
      return 'deactivated';
    default: {
      // Exhaustiveness: adding a status without handling it fails to compile rather than
      // falling through to "allowed", which is the direction that matters.
      const unreachable: never = status;
      return unreachable;
    }
  }
}

/**
 * Normalises an email for storage and comparison.
 *
 * The column is `citext`, so the database already compares case-insensitively. Trimming is
 * still ours to do: a trailing space from a paste is otherwise a different address, and the
 * user gets "account already exists" for an address they cannot then sign in with.
 *
 * Deliberately NOT normalising further — gmail dot-stripping, plus-tag removal. Those are
 * provider-specific policies, they are wrong for other providers, and applying them means
 * two people at a domain that treats tags as distinct mailboxes collide on one account.
 */
export function normaliseEmail(email: string): string {
  return email.trim();
}

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function isPlausibleEmail(email: string): boolean {
  const trimmed = normaliseEmail(email);
  // Deliberately loose. Full RFC 5322 validation rejects addresses that work, and the only
  // real proof an address exists is that the verification email arrives.
  return trimmed.length <= 320 && EMAIL.test(trimmed);
}

/** Token lifetimes. Short for anything that grants access, longer for a first sign-up. */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
export const EMAIL_CHANGE_TTL_MS = 60 * 60 * 1000;

export type UserTokenPurpose = 'email_verification' | 'password_reset' | 'email_change';

export function tokenTtlMs(purpose: UserTokenPurpose): number {
  switch (purpose) {
    case 'email_verification':
      return EMAIL_VERIFICATION_TTL_MS;
    case 'password_reset':
      return PASSWORD_RESET_TTL_MS;
    case 'email_change':
      return EMAIL_CHANGE_TTL_MS;
    default: {
      const unreachable: never = purpose;
      return unreachable;
    }
  }
}

/** How many recovery codes are issued when MFA is enabled. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * Whether a credential can satisfy an MFA challenge.
 *
 * An unconfirmed credential must never count, or enrolment itself becomes the bypass: an
 * attacker with a stolen session could start enrolling a factor and immediately use it.
 */
export function canSatisfyMfa(credential: { readonly confirmedAt: Date | null }): boolean {
  return credential.confirmedAt !== null;
}
