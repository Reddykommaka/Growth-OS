/**
 * TOTP (RFC 6238) over HOTP (RFC 4226).
 *
 * WHY THIS IS HAND-WRITTEN. 06-identity-and-access.md §1 names `oslo` for crypto
 * primitives. `oslo` is now marked "no longer supported" by its author, and an unmaintained
 * dependency inside the authentication layer is a worse risk than the small amount of code
 * it saves. The algorithm is ~40 lines of HMAC and a truncation, and RFC 6238 publishes
 * official test vectors — so this implementation is verified against the standard itself,
 * which is stronger assurance than trusting an abandoned package.
 *
 * `@node-rs/argon2` (also named in 06 §1) is actively maintained and is used as specified.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { base32Encode } from './encoding.js';

/** 160 bits, the size RFC 4226 §4 requires and what authenticator apps assume. */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpOptions {
  readonly digits?: number;
  readonly periodSeconds?: number;
  readonly algorithm?: TotpAlgorithm;
}

const DEFAULTS = { digits: 6, periodSeconds: 30, algorithm: 'SHA1' as const };

/**
 * HOTP for one counter value (RFC 4226 §5.3).
 *
 * SHA1 is the default because every authenticator app implements it and almost none
 * implement the alternatives. That is not a weakness here: HOTP's security rests on the
 * HMAC construction and the shared secret, and HMAC-SHA1 has no practical break. The
 * collision attacks that retired SHA1 for signatures do not apply to HMAC.
 */
function hotp(secret: Buffer, counter: bigint, digits: number, algorithm: TotpAlgorithm): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter);

  const digest = createHmac(algorithm.toLowerCase(), secret).update(counterBytes).digest();

  // Dynamic truncation: the low nibble of the last byte picks the offset.
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/** The code for a given instant. */
export function generateTotp(secret: Buffer, at: Date, options: TotpOptions = {}): string {
  const { digits, periodSeconds, algorithm } = { ...DEFAULTS, ...options };
  const counter = BigInt(Math.floor(at.getTime() / 1000 / periodSeconds));
  return hotp(secret, counter, digits, algorithm);
}

export interface VerifyTotpOptions extends TotpOptions {
  /**
   * How many periods either side of `at` to accept. One step (±30s) absorbs ordinary clock
   * drift between a phone and the server.
   *
   * Widening this multiplies the codes valid at any instant, which is a direct reduction in
   * strength — at window 1 there are 3 of a million, at window 5 there are 11.
   */
  readonly window?: number;
}

/**
 * Verifies a submitted code.
 *
 * Every candidate in the window is compared, and the comparison is constant-time. Returning
 * on the first match would leak, through timing, WHICH step matched — which narrows the
 * server's clock offset for an attacker and is free to avoid.
 *
 * REPLAY IS NOT HANDLED HERE. A code stays valid for its whole period, so an intercepted one
 * can be reused within it. The caller must record the accepted counter against the
 * credential and refuse it a second time; this function cannot, because it holds no state.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  at: Date,
  options: VerifyTotpOptions = {},
): boolean {
  const { digits, periodSeconds, algorithm } = { ...DEFAULTS, ...options };
  const window = options.window ?? 1;

  const submitted = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(submitted)) return false;

  const submittedBuffer = Buffer.from(submitted, 'utf8');
  const counter = BigInt(Math.floor(at.getTime() / 1000 / periodSeconds));

  let matched = false;
  for (let offset = -window; offset <= window; offset++) {
    const candidate = hotp(secret, counter + BigInt(offset), digits, algorithm);
    const candidateBuffer = Buffer.from(candidate, 'utf8');
    if (
      candidateBuffer.length === submittedBuffer.length &&
      timingSafeEqual(candidateBuffer, submittedBuffer)
    ) {
      matched = true;
    }
  }
  return matched;
}

/** Which counter a code corresponds to, so the caller can store it and refuse a replay. */
export function totpCounterFor(at: Date, periodSeconds = DEFAULTS.periodSeconds): bigint {
  return BigInt(Math.floor(at.getTime() / 1000 / periodSeconds));
}

/** The otpauth:// URI an authenticator app consumes, usually via a QR code. */
export function totpUri(params: {
  readonly secret: Buffer;
  readonly accountName: string;
  readonly issuer: string;
  readonly options?: TotpOptions;
}): string {
  const { digits, periodSeconds, algorithm } = { ...DEFAULTS, ...params.options };
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.accountName)}`;
  const query = new URLSearchParams({
    secret: base32Encode(params.secret),
    issuer: params.issuer,
    algorithm,
    digits: String(digits),
    period: String(periodSeconds),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
