/**
 * TOTP verified against the RFC 6238 Appendix B test vectors.
 *
 * This implementation is hand-written because `oslo` — named in 06 §1 — is now marked "no
 * longer supported" by its author. The vectors are what make that safe: they are published
 * by the standard, so this is checked against the specification rather than against another
 * implementation that might share a bug.
 */
import { describe, expect, it } from 'vitest';
import { base32Encode } from './encoding.js';
import { generateTotp, generateTotpSecret, totpCounterFor, totpUri, verifyTotp } from './totp.js';

/** RFC 6238 Appendix B: the ASCII seed "12345678901234567890". */
const RFC_SECRET_SHA1 = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET_SHA256 = Buffer.from('12345678901234567890123456789012', 'ascii');
const RFC_SECRET_SHA512 = Buffer.from(
  '1234567890123456789012345678901234567890123456789012345678901234',
  'ascii',
);

describe('RFC 6238 Appendix B vectors — SHA1', () => {
  it.each([
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ])('at t=%i produces %s', (seconds, expected) => {
    expect(generateTotp(RFC_SECRET_SHA1, new Date(seconds * 1000), { digits: 8 })).toBe(expected);
  });
});

describe('RFC 6238 Appendix B vectors — SHA256', () => {
  it.each([
    [59, '46119246'],
    [1_111_111_109, '68084774'],
    [1_234_567_890, '91819424'],
    [20_000_000_000, '77737706'],
  ])('at t=%i produces %s', (seconds, expected) => {
    expect(
      generateTotp(RFC_SECRET_SHA256, new Date(seconds * 1000), {
        digits: 8,
        algorithm: 'SHA256',
      }),
    ).toBe(expected);
  });
});

describe('RFC 6238 Appendix B vectors — SHA512', () => {
  it.each([
    [59, '90693936'],
    [1_111_111_109, '25091201'],
    [1_234_567_890, '93441116'],
    [20_000_000_000, '47863826'],
  ])('at t=%i produces %s', (seconds, expected) => {
    expect(
      generateTotp(RFC_SECRET_SHA512, new Date(seconds * 1000), {
        digits: 8,
        algorithm: 'SHA512',
      }),
    ).toBe(expected);
  });
});

describe('verification', () => {
  const secret = RFC_SECRET_SHA1;
  const at = new Date(1_234_567_890 * 1000);

  it('accepts the current code', () => {
    const code = generateTotp(secret, at);
    expect(verifyTotp(secret, code, at)).toBe(true);
  });

  it('accepts one step of clock drift in each direction', () => {
    const before = generateTotp(secret, new Date(at.getTime() - 30_000));
    const after = generateTotp(secret, new Date(at.getTime() + 30_000));
    expect(verifyTotp(secret, before, at)).toBe(true);
    expect(verifyTotp(secret, after, at)).toBe(true);
  });

  it('rejects two steps of drift at the default window', () => {
    const stale = generateTotp(secret, new Date(at.getTime() - 90_000));
    expect(verifyTotp(secret, stale, at)).toBe(false);
  });

  it('rejects a code for a different secret', () => {
    const other = generateTotpSecret();
    expect(verifyTotp(other, generateTotp(secret, at), at)).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', 'abcdef', '12345', '1234567', '12 34 56', '../../etc']) {
      expect(verifyTotp(secret, bad, at), bad).toBe(false);
    }
  });

  it('tolerates whitespace, which is how people paste codes', () => {
    const code = generateTotp(secret, at);
    expect(verifyTotp(secret, ` ${code.slice(0, 3)} ${code.slice(3)} `, at)).toBe(true);
  });

  /**
   * Replay is the caller's job, and the interface has to make that possible. The counter is
   * exposed precisely so a consumed code can be recorded and refused a second time.
   */
  it('exposes the counter so the caller can refuse a replay', () => {
    expect(totpCounterFor(at)).toBe(BigInt(Math.floor(1_234_567_890 / 30)));
    expect(totpCounterFor(new Date(at.getTime() + 30_000))).toBe(totpCounterFor(at) + 1n);
  });

  it('a wider window accepts more codes — the cost of tolerance, made visible', () => {
    const farStale = generateTotp(secret, new Date(at.getTime() - 150_000));
    expect(verifyTotp(secret, farStale, at)).toBe(false);
    expect(verifyTotp(secret, farStale, at, { window: 5 })).toBe(true);
  });
});

describe('secret generation and enrolment', () => {
  it('produces a 160-bit secret, as RFC 4226 §4 requires', () => {
    expect(generateTotpSecret()).toHaveLength(20);
  });

  it('produces a different secret each time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateTotpSecret().toString('hex')));
    expect(seen.size).toBe(50);
  });

  it('builds an otpauth URI an authenticator app can consume', () => {
    const uri = totpUri({
      secret: RFC_SECRET_SHA1,
      accountName: 'ada@example.test',
      issuer: 'Growth OS',
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Growth%20OS:ada%40example\.test\?/);
    const params = new URL(uri).searchParams;
    expect(params.get('secret')).toBe(base32Encode(RFC_SECRET_SHA1));
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
  });
});
