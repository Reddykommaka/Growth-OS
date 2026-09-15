/**
 * Opaque tokens and their stored hashes.
 *
 * Every credential in this system follows one shape (06-identity-and-access.md §2):
 * high-entropy random bytes handed to the holder once, and only `sha256(token)` persisted.
 * A database leak therefore yields nothing usable — not a session, not an invitation, not
 * an API key.
 *
 * SHA-256 rather than Argon2 for these, deliberately. A password is low-entropy and needs a
 * slow hash to survive offline cracking. A 256-bit random token has nothing to crack: the
 * work factor buys no security and would be paid on every request that validates a session.
 * API key SECRETS are the exception and use Argon2, because a key's prefix is public and
 * narrows the search space.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { base32Encode } from './encoding.js';

/** 256 bits, per 06 §2. */
const TOKEN_BYTES = 32;

export interface IssuedToken {
  /** Shown to the holder once. Never stored. */
  readonly token: string;
  /** What goes in the database. */
  readonly tokenHash: Buffer;
}

/**
 * Mints a token.
 *
 * base64url rather than hex: same entropy in 43 characters instead of 64, which matters for
 * a value that travels in a cookie and in URLs (an email-verification link), and avoids any
 * percent-encoding of `+` and `/`.
 */
export function issueToken(): IssuedToken {
  const raw = randomBytes(TOKEN_BYTES);
  const token = raw.toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Compares two token hashes without leaking, through timing, how much of them matched.
 *
 * A session lookup indexes on the hash and so does not need this, but any path that compares
 * a candidate to a known value does — and having the safe comparison available is what stops
 * `===` appearing in one.
 */
export function tokenHashEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * API key format: `gos_live_<prefix>_<secret>` (06 §2).
 *
 * The prefix is stored in clear so a key is identifiable in a list and by GitHub secret
 * scanning; the secret is Argon2-hashed. Splitting them means a leaked key can be located
 * and revoked without the secret ever being recoverable.
 */
export const API_KEY_PREFIX_BYTES = 6;
export const API_KEY_SECRET_BYTES = 24;

export interface IssuedApiKey {
  /** Shown once at creation and never recoverable. */
  readonly key: string;
  /** Public half, stored in clear and uniquely indexed. */
  readonly prefix: string;
  /** Secret half, to be Argon2-hashed by the caller before storage. */
  readonly secret: string;
}

export function issueApiKey(environment: 'live' | 'test' = 'live'): IssuedApiKey {
  // base32, NOT base64url. The key format uses `_` as its field separator, and base64url's
  // alphabet contains `_` — so roughly one key in three carried a separator inside its own
  // prefix or secret and could not be parsed back. base32's alphabet is A-Z and 2-7 only.
  const prefix = base32Encode(randomBytes(API_KEY_PREFIX_BYTES));
  const secret = base32Encode(randomBytes(API_KEY_SECRET_BYTES));
  return { key: `gos_${environment}_${prefix}_${secret}`, prefix, secret };
}

export interface ParsedApiKey {
  readonly environment: string;
  readonly prefix: string;
  readonly secret: string;
}

/**
 * Parses a presented key into its parts.
 *
 * Returns undefined rather than throwing for anything malformed: a bad key is an
 * authentication failure, not an exception, and the caller must treat "wrong shape" and
 * "wrong secret" identically so the format itself is not an oracle.
 */
export function parseApiKey(key: string): ParsedApiKey | undefined {
  const parts = key.split('_');
  if (parts.length !== 4) return undefined;
  const [scheme, environment, prefix, secret] = parts;
  if (scheme !== 'gos') return undefined;
  if (environment !== 'live' && environment !== 'test') return undefined;
  if (prefix === undefined || secret === undefined) return undefined;
  if (prefix.length === 0 || secret.length === 0) return undefined;
  return { environment, prefix, secret };
}

/**
 * Recovery codes for MFA: single-use, hashed, displayed once.
 *
 * Grouped as `xxxx-xxxx` for transcription. Crockford's alphabet minus the ambiguous
 * characters, so a code read off paper cannot be mistyped as a different VALID code — the
 * failure mode that makes a user burn a second code and eventually lock themselves out.
 */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function issueRecoveryCode(): string {
  const groups = [0, 1].map(() => {
    let out = '';
    // Rejection sampling: the alphabet is 32 characters, so every 5-bit slice is uniform
    // and no modulo bias exists. Taking bytes % 32 would be uniform here too, but only by
    // coincidence of the alphabet length — this stays correct if the alphabet changes.
    const bytes = randomBytes(8);
    for (let i = 0; i < 4; i++) {
      const byte = bytes[i] ?? 0;
      out += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    }
    return out;
  });
  return groups.join('-');
}

/** Normalises a code as typed: case and separators vary, the value does not. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function hashRecoveryCode(code: string): Buffer {
  return createHash('sha256').update(normaliseRecoveryCode(code), 'utf8').digest();
}
