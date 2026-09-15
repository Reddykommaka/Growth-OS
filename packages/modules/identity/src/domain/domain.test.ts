/**
 * Identity domain rules.
 *
 * Pure decisions made from values alone, so they are testable exhaustively without a
 * database — which is the point of keeping them separate. The lockout arithmetic in
 * particular decides how long online guessing stays worthwhile, and it should be readable
 * from its tests rather than inferred from the code.
 */
import { describe, expect, it } from 'vitest';
import {
  afterFailedAttempt,
  CLEARED_LOCKOUT,
  canSatisfyMfa,
  DEFAULT_LOCKOUT_POLICY,
  EMAIL_VERIFICATION_TTL_MS,
  isLocked,
  isPlausibleEmail,
  normaliseEmail,
  PASSWORD_RESET_TTL_MS,
  RECOVERY_CODE_COUNT,
  refusalForStatus,
  tokenTtlMs,
  type UserStatus,
} from './index.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');

describe('lockout', () => {
  it('counts failures without locking below the threshold', () => {
    let state = { failedLoginCount: 0, lockedUntil: null as Date | null };
    for (let i = 1; i < DEFAULT_LOCKOUT_POLICY.threshold; i++) {
      state = afterFailedAttempt(state, NOW);
      expect(state.failedLoginCount).toBe(i);
      expect(isLocked(state, NOW), `attempt ${i}`).toBe(false);
    }
  });

  it('locks exactly at the threshold', () => {
    let state = { failedLoginCount: 0, lockedUntil: null as Date | null };
    for (let i = 0; i < DEFAULT_LOCKOUT_POLICY.threshold; i++) {
      state = afterFailedAttempt(state, NOW);
    }
    expect(isLocked(state, NOW)).toBe(true);
    expect(state.lockedUntil?.getTime()).toBe(
      NOW.getTime() + DEFAULT_LOCKOUT_POLICY.lockDurationMs,
    );
  });

  it('releases once the window passes', () => {
    const locked = { failedLoginCount: 5, lockedUntil: new Date(NOW.getTime() + 1000) };
    expect(isLocked(locked, NOW)).toBe(true);
    expect(isLocked(locked, new Date(NOW.getTime() + 1001))).toBe(false);
  });

  /**
   * The rate this policy permits, stated as a number rather than left implicit: five
   * attempts per fifteen minutes is 20 guesses an hour, which makes online guessing of any
   * real password worthless while staying above the number of times someone mistypes one
   * they actually know.
   */
  it('permits roughly twenty guesses an hour', () => {
    const perHour =
      (DEFAULT_LOCKOUT_POLICY.threshold * 60 * 60 * 1000) / DEFAULT_LOCKOUT_POLICY.lockDurationMs;
    expect(perHour).toBe(20);
  });

  it('clears to a state that is not locked', () => {
    expect(isLocked(CLEARED_LOCKOUT, NOW)).toBe(false);
    expect(CLEARED_LOCKOUT.failedLoginCount).toBe(0);
  });

  it('treats a null lock as unlocked', () => {
    expect(isLocked({ failedLoginCount: 99, lockedUntil: null }, NOW)).toBe(false);
  });
});

describe('status refusals', () => {
  it.each([
    ['active', undefined],
    ['pending_verification', 'email_unverified'],
    ['suspended', 'suspended'],
    ['deactivated', 'deactivated'],
  ] as const)('%s → %s', (status, expected) => {
    expect(refusalForStatus(status as UserStatus)).toBe(expected);
  });

  it('permits sign-in for exactly one status', () => {
    const statuses: UserStatus[] = ['active', 'pending_verification', 'suspended', 'deactivated'];
    expect(statuses.filter((s) => refusalForStatus(s) === undefined)).toEqual(['active']);
  });
});

describe('email normalisation', () => {
  it('trims, so a pasted address is the same address', () => {
    expect(normaliseEmail('  ada@example.test \n')).toBe('ada@example.test');
  });

  /**
   * Deliberately NOT lower-casing here: the column is citext, so the database compares
   * case-insensitively while preserving what the user typed. Folding case in the application
   * would mean the address shown back to them is not the one they entered.
   */
  it('preserves case, which citext handles at the database', () => {
    expect(normaliseEmail('Ada@Example.test')).toBe('Ada@Example.test');
  });

  /**
   * And deliberately NOT stripping dots or plus-tags. Those are provider-specific policies,
   * wrong for other providers, and applying them collides two distinct mailboxes at any
   * domain that treats tags as separate.
   */
  it('preserves plus-tags and dots as distinct addresses', () => {
    expect(normaliseEmail('a.da+work@example.test')).toBe('a.da+work@example.test');
  });

  it.each([
    'ada@example.test',
    'a.da+work@example.test',
    'ada@sub.example.co.uk',
    "o'brien@example.test",
  ])('accepts %s', (email) => {
    expect(isPlausibleEmail(email)).toBe(true);
  });

  it.each(['', 'ada', 'ada@', '@example.test', 'ada@example', 'a b@c.test', 'ada@@example.test'])(
    'rejects %s',
    (email) => {
      expect(isPlausibleEmail(email)).toBe(false);
    },
  );

  it('rejects an address beyond the 320-character limit', () => {
    expect(isPlausibleEmail(`${'a'.repeat(320)}@example.test`)).toBe(false);
  });
});

describe('token lifetimes', () => {
  it('gives a verification link a day and a reset link an hour', () => {
    expect(tokenTtlMs('email_verification')).toBe(EMAIL_VERIFICATION_TTL_MS);
    expect(tokenTtlMs('password_reset')).toBe(PASSWORD_RESET_TTL_MS);
    expect(EMAIL_VERIFICATION_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(PASSWORD_RESET_TTL_MS).toBe(60 * 60 * 1000);
  });

  /**
   * A reset token grants immediate account takeover if intercepted; a verification token
   * only confirms an address the holder already controls. The shorter window on the more
   * dangerous one is the whole reason these differ.
   */
  it('gives the more dangerous token the shorter life', () => {
    expect(tokenTtlMs('password_reset')).toBeLessThan(tokenTtlMs('email_verification'));
  });
});

describe('MFA credential eligibility', () => {
  /**
   * An unconfirmed credential must never satisfy a challenge, or starting enrolment is
   * itself the bypass.
   */
  it('refuses an unconfirmed credential', () => {
    expect(canSatisfyMfa({ confirmedAt: null })).toBe(false);
  });

  it('accepts a confirmed one', () => {
    expect(canSatisfyMfa({ confirmedAt: NOW })).toBe(true);
  });

  it('issues ten recovery codes', () => {
    expect(RECOVERY_CODE_COUNT).toBe(10);
  });
});
