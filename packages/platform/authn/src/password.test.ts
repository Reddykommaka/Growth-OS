/**
 * Password hashing.
 *
 * The assertions that matter here are about COST and about TIMING, because both are the
 * actual security properties — a correct-looking Argon2 call with the wrong parameters, or a
 * verification that returns early for unknown users, fails silently and passes every
 * functional test.
 */
import { ValidationError } from '@growth-os/errors';
import { describe, expect, it } from 'vitest';
import {
  ARGON2_OPTIONS,
  type BreachedPasswordCheck,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password.js';

const PASSWORD = 'correct horse battery staple';

describe('the hash is Argon2id at the specified cost', () => {
  /**
   * Asserted against the ENCODED OUTPUT, not against the constant we passed in. The
   * algorithm is a bare `2` in the source (the library's const enum cannot be imported under
   * verbatimModuleSyntax), and a bare number in a security parameter is exactly what drifts
   * unnoticed. This reads back what Argon2 actually did.
   */
  it('encodes argon2id, m=65536, t=3, p=4', async () => {
    const encoded = await hashPassword(PASSWORD);
    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
  });

  it('matches the exported options, so the two cannot drift apart', () => {
    expect(ARGON2_OPTIONS.memoryCost).toBe(65_536);
    expect(ARGON2_OPTIONS.timeCost).toBe(3);
    expect(ARGON2_OPTIONS.parallelism).toBe(4);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, PASSWORD)).toBe(true);
    expect(await verifyPassword(b, PASSWORD)).toBe(true);
  });
});

describe('verification', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const encoded = await hashPassword(PASSWORD);
    expect(await verifyPassword(encoded, PASSWORD)).toBe(true);
    expect(await verifyPassword(encoded, 'correct horse battery stapl')).toBe(false);
  });

  it('treats a malformed stored hash as a wrong password, not an error', async () => {
    // A thrown error here could be caught upstream as a transient failure and retried,
    // which is how a lockout counter gets bypassed.
    for (const broken of ['', 'not-a-hash', '$argon2id$truncated']) {
      expect(await verifyPassword(broken, PASSWORD), broken).toBe(false);
    }
  });

  /**
   * The account-enumeration defence (06 §2). An unknown address must cost the same as a
   * known one, or the login endpoint answers "does this person have an account?" for free.
   */
  it('costs comparable time for an unknown user as for a known one', async () => {
    const encoded = await hashPassword(PASSWORD);

    // Warm the dummy hash first; its one-off computation is not part of the measurement.
    await verifyPassword(null, PASSWORD);

    const time = async (hash: string | null): Promise<number> => {
      const start = process.hrtime.bigint();
      await verifyPassword(hash, PASSWORD);
      return Number(process.hrtime.bigint() - start) / 1e6;
    };

    const known = Math.min(...(await Promise.all([time(encoded), time(encoded), time(encoded)])));
    const unknown = Math.min(...(await Promise.all([time(null), time(null), time(null)])));

    // Both paths run a full Argon2 verification, so they are the same order of magnitude.
    // A bounded ratio rather than an exact match: this is a loaded CI box, and asserting
    // tight equality would produce a flaky test that gets deleted rather than trusted.
    const ratio = Math.max(known, unknown) / Math.max(Math.min(known, unknown), 0.001);
    expect(ratio, `known=${known}ms unknown=${unknown}ms`).toBeLessThan(5);
  });

  it('returns false for a user with no password — an OAuth-only account', async () => {
    expect(await verifyPassword(null, PASSWORD)).toBe(false);
  });
});

describe('policy', () => {
  it('rejects a password below the minimum length', async () => {
    await expect(hashPassword('short')).rejects.toThrow(ValidationError);
  });

  it('accepts exactly the minimum', async () => {
    await expect(hashPassword('a'.repeat(12))).resolves.toMatch(/^\$argon2id\$/);
  });

  /**
   * Counted in GRAPHEMES — user-perceived characters — not UTF-16 units or code points.
   *
   * One family emoji is 11 UTF-16 units and 7 code points, but one thing the user chose.
   * Under either of the other two units, two of them clear a 12-character minimum while
   * carrying the entropy of two selections.
   */
  it('counts graphemes, so emoji cannot fake length', async () => {
    const twoFamilies = '👨‍👩‍👧‍👦👨‍👩‍👧‍👦';
    expect(twoFamilies.length).toBeGreaterThan(12); // UTF-16 units would pass
    expect([...twoFamilies]).toHaveLength(14); // code points would pass too
    await expect(hashPassword(twoFamilies)).rejects.toThrow(ValidationError);
  });

  it('accepts twelve real graphemes, emoji included', async () => {
    await expect(hashPassword('🔒'.repeat(12))).resolves.toMatch(/^\$argon2id\$/);
  });

  it('rejects an unbounded password — Argon2 cost is paid on our hardware', async () => {
    await expect(hashPassword('a'.repeat(1025))).rejects.toThrow(/at most/);
  });

  it('imposes no composition rules', async () => {
    // All lower case, no digits, no symbols: long is what matters (NIST SP 800-63B).
    await expect(hashPassword('correcthorsebatterystaple')).resolves.toBeTruthy();
  });

  it('rejects a password found in a breach corpus', async () => {
    const breachCheck: BreachedPasswordCheck = {
      isBreached: async (p) => p === 'password123456',
    };
    await expect(hashPassword('password123456', { breachCheck })).rejects.toThrow(/data breach/i);
    await expect(hashPassword(PASSWORD, { breachCheck })).resolves.toBeTruthy();
  });
});

describe('rehash detection', () => {
  it('leaves a current hash alone', async () => {
    expect(needsRehash(await hashPassword(PASSWORD))).toBe(false);
  });

  it('flags a hash made with weaker parameters', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=3,p=4$abc$def')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=65536,t=1,p=4$abc$def')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=65536,t=3,p=1$abc$def')).toBe(true);
  });

  it('flags anything that is not argon2id at all', () => {
    expect(needsRehash('$argon2i$v=19$m=65536,t=3,p=4$abc$def')).toBe(true);
    expect(needsRehash('$2b$12$abcdefghijklmnopqrstuv')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });
});
