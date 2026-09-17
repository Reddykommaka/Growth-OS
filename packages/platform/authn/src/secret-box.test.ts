/**
 * Authenticated encryption for recoverable secrets.
 *
 * The tests that matter are the negative ones: that tampering is DETECTED, and that a wrong
 * key fails rather than producing plausible garbage.
 */
import { InternalError } from '@growth-os/errors';
import { describe, expect, it } from 'vitest';
import { createSecretCipher, generateSecretKey, secretEquals } from './secret-box.js';

const KEY = generateSecretKey();
const cipher = createSecretCipher(KEY);
const SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('round trip', () => {
  it('recovers the plaintext exactly', () => {
    expect(cipher.decrypt(cipher.encrypt(SECRET)).equals(SECRET)).toBe(true);
  });

  it('handles an empty buffer', () => {
    expect(cipher.decrypt(cipher.encrypt(Buffer.alloc(0))).length).toBe(0);
  });

  it('handles a large secret', () => {
    const big = Buffer.alloc(100_000, 7);
    expect(cipher.decrypt(cipher.encrypt(big)).equals(big)).toBe(true);
  });

  /**
   * A fresh IV every time. Reusing a nonce under GCM leaks the XOR of the plaintexts and
   * enables forgery, so identical input must never produce identical output.
   */
  it('produces different ciphertext for the same plaintext', () => {
    const outputs = new Set(
      Array.from({ length: 200 }, () => cipher.encrypt(SECRET).toString('base64')),
    );
    expect(outputs.size).toBe(200);
  });

  it('never contains the plaintext', () => {
    const encrypted = cipher.encrypt(SECRET);
    expect(encrypted.includes(SECRET)).toBe(false);
  });
});

/**
 * Flips one bit, failing loudly if the offset is out of range.
 *
 * `buf[i] ^= 1` on an out-of-range index is a silent no-op in JavaScript — the tamper never
 * happens and the test then asserts that untampered ciphertext decrypts, which it does. The
 * suite would pass while testing nothing. `noUncheckedIndexedAccess` is what surfaced it.
 */
function flipBit(buffer: Buffer, index: number): void {
  const byte = buffer[index];
  if (byte === undefined) throw new Error(`offset ${index} is outside the ciphertext`);
  buffer[index] = byte ^ 0x01;
}

describe('tampering is detected, not silently decrypted', () => {
  it('rejects a flipped bit in the body', () => {
    const encrypted = cipher.encrypt(SECRET);
    flipBit(encrypted, encrypted.length - 1);
    expect(() => cipher.decrypt(encrypted)).toThrow(/Could not decrypt/);
  });

  it('rejects a flipped bit in the IV', () => {
    const encrypted = cipher.encrypt(SECRET);
    flipBit(encrypted, 2);
    expect(() => cipher.decrypt(encrypted)).toThrow(/Could not decrypt/);
  });

  it('rejects a flipped bit in the auth tag', () => {
    const encrypted = cipher.encrypt(SECRET);
    flipBit(encrypted, 14);
    expect(() => cipher.decrypt(encrypted)).toThrow(/Could not decrypt/);
  });

  it('rejects truncated ciphertext', () => {
    const encrypted = cipher.encrypt(SECRET);
    expect(() => cipher.decrypt(encrypted.subarray(0, 10))).toThrow(/too short/);
  });

  it('rejects an unknown version byte, rather than mis-decrypting', () => {
    const encrypted = cipher.encrypt(SECRET);
    encrypted[0] = 99;
    expect(() => cipher.decrypt(encrypted)).toThrow(/Unsupported ciphertext version/);
  });
});

describe('keys', () => {
  it('cannot decrypt with a different key', () => {
    const other = createSecretCipher(generateSecretKey());
    expect(() => other.decrypt(cipher.encrypt(SECRET))).toThrow(/Could not decrypt/);
  });

  /**
   * Validated at construction, so a misconfigured deployment fails at BOOT. A process that
   * starts happily and then cannot decrypt anyone's MFA secret is far worse.
   */
  it('refuses a key of the wrong length at construction', () => {
    expect(() => createSecretCipher(Buffer.alloc(16).toString('base64'))).toThrow(InternalError);
    expect(() => createSecretCipher('')).toThrow(/must be 32 bytes/);
    expect(() => createSecretCipher('not-base64!!')).toThrow(/must be 32 bytes/);
  });

  it('generates a 32-byte key', () => {
    expect(Buffer.from(generateSecretKey(), 'base64')).toHaveLength(32);
  });

  it('generates a different key each time', () => {
    expect(new Set(Array.from({ length: 100 }, generateSecretKey)).size).toBe(100);
  });
});

describe('constant-time comparison', () => {
  it('matches equal buffers and rejects others, including different lengths', () => {
    expect(secretEquals(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    expect(secretEquals(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
    expect(secretEquals(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false);
  });
});
