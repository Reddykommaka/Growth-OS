/**
 * Base32, against the RFC 4648 §10 test vectors.
 *
 * Shared by TOTP enrolment and API-key issuance. The API-key use is the reason it exists
 * separately: base64url's alphabet contains `_`, which is the key format's field separator,
 * so roughly one key in three could not be parsed back. base32's alphabet cannot collide.
 */
import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode } from './encoding.js';

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (let length = 0; length <= 40; length++) {
      const data = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + 11) % 256));
      expect(base32Decode(base32Encode(data)).equals(data), `length ${length}`).toBe(true);
    }
  });

  it('matches RFC 4648 §10 test vectors', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [input, expected] of vectors) {
      expect(base32Encode(Buffer.from(input, 'ascii')), input).toBe(expected);
    }
  });

  it('accepts padding and whitespace when decoding, as users paste it', () => {
    expect(base32Decode('MZXW 6YTB OI===').toString('ascii')).toBe('foobar');
  });

  it('rejects an invalid character rather than silently producing bytes', () => {
    expect(() => base32Decode('MZXW6YTB1')).toThrow(/Invalid base32/);
  });
});
