/**
 * Authenticated encryption for secrets that must be recoverable.
 *
 * Almost everything in this system is hashed, not encrypted — a session token, a password,
 * an invitation. A TOTP secret is the exception: verifying a code requires the secret back,
 * so `mfa_credentials.secret_encrypted` holds ciphertext rather than a digest.
 *
 * AES-256-GCM, because the requirement is authenticated encryption. Plain AES-CBC would let
 * an attacker with write access to the column flip ciphertext bits and have us decrypt to
 * something else without noticing; GCM's tag makes tampering a decryption failure.
 *
 * The key never appears in the database. A dump therefore yields ciphertext and nothing
 * else, which is the property that makes storing the secret at all acceptable.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { InternalError } from '@growth-os/errors';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** 96 bits is the GCM-recommended nonce size; anything else costs a GHASH step. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Lets a future algorithm change be detected rather than mis-decrypted. */
const VERSION = 1;

export interface SecretCipher {
  encrypt(plaintext: Buffer): Buffer;
  decrypt(ciphertext: Buffer): Buffer;
}

/**
 * Builds a cipher from a 32-byte key.
 *
 * The key arrives from the secret manager as base64. It is validated on construction rather
 * than on first use so a misconfigured deployment fails at boot — a process that starts
 * happily and then cannot decrypt anyone's MFA secret is far worse than one that refuses to
 * start.
 */
export function createSecretCipher(keyBase64: string): SecretCipher {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new InternalError(
      `The secret encryption key must be ${KEY_BYTES} bytes (base64-encoded); got ${key.length}.`,
    );
  }

  return {
    encrypt(plaintext: Buffer): Buffer {
      // A fresh IV per encryption. Reusing one under GCM is catastrophic — it leaks the
      // XOR of the plaintexts and allows forgery — so it is generated here and never
      // supplied by a caller.
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
    },

    decrypt(payload: Buffer): Buffer {
      if (payload.length < 1 + IV_BYTES + TAG_BYTES) {
        throw new InternalError('Ciphertext is too short to be valid.');
      }
      const version = payload[0];
      if (version !== VERSION) {
        throw new InternalError(`Unsupported ciphertext version ${String(version)}.`);
      }
      const iv = payload.subarray(1, 1 + IV_BYTES);
      const tag = payload.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
      const body = payload.subarray(1 + IV_BYTES + TAG_BYTES);

      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        // GCM tag mismatch. Deliberately opaque: the caller must not learn whether the key
        // was wrong or the ciphertext was altered.
        throw new InternalError('Could not decrypt the stored secret.');
      }
    },
  };
}

/** Generates a key for a new environment. Printed once, stored in the secret manager. */
export function generateSecretKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/** Constant-time buffer comparison, for callers outside the token module. */
export function secretEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
