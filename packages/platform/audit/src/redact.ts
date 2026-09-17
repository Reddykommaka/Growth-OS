/**
 * Metadata redaction — the last line of defence, not the first.
 *
 * The first line is that services pass CURATED metadata: a prefix, a role slug, a count.
 * Nothing in this file makes it safe to hand the audit log an arbitrary request body.
 *
 * It exists because the cost of the two mistakes is wildly asymmetric. A redacted field that
 * did not need redacting is a mild loss of forensic detail. A credential written into an
 * append-only, seven-year-retained, widely-readable table cannot be removed — the table has
 * no UPDATE or DELETE grant, by design. So this errs heavily towards redaction.
 */

/**
 * Key names whose VALUE is never recorded, matched case-insensitively as a substring.
 *
 * Substring rather than exact match, because the same secret arrives under many spellings —
 * `token`, `access_token`, `accessToken`, `refreshToken`, `providerToken`. An exact list
 * would need every variant enumerated and would silently miss the next one.
 */
const SECRET_KEY_FRAGMENTS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'credential',
  'authorization',
  'cookie',
  'session',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'signature',
  'otp',
  'totp',
  'mfa',
  'recovery',
  'verifier',
  'nonce',
  'salt',
  'hash',
  'seed',
  'pin',
];

/**
 * Key names that survive despite matching a fragment above.
 *
 * `token_hash` and `prefix` are the identifiers an investigation actually needs: a prefix is
 * the public half of an API key and is how a leaked key is located and revoked. Listing the
 * exceptions explicitly keeps the denylist aggressive without making it useless.
 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'prefix',
  'sessionid',
  'session_id',
  'apikeyid',
  'api_key_id',
  'tokenid',
  'token_id',
  'mfamethod',
  'mfa_method',
  'sessioncount',
  'session_count',
]);

export const REDACTED = '[redacted]';

function isSecretKey(key: string): boolean {
  const normalised = key.toLowerCase();
  if (ALLOWED_KEYS.has(normalised)) return false;
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

/**
 * How deep to walk. Beyond this the value is replaced wholesale rather than descended into.
 *
 * A bound is required: metadata arrives from callers, and a deeply nested or cyclic object
 * would otherwise turn every audited action into a stack overflow — and an audit write that
 * throws is a lost security record.
 */
const MAX_DEPTH = 6;

/** How many array elements are kept. The rest are summarised, not dropped silently. */
const MAX_ARRAY = 50;

/** Values that are already safe to store as-is. */
function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** Raw bytes are a hash, a key or a token. Nothing else arrives as one. */
function isBinary(value: unknown): boolean {
  return Buffer.isBuffer(value) || ArrayBuffer.isView(value);
}

function redactArray(value: readonly unknown[], depth: number): unknown[] {
  const kept = value.slice(0, MAX_ARRAY).map((item) => redactValue(item, depth + 1));
  return value.length > MAX_ARRAY ? [...kept, `[${value.length - MAX_ARRAY} more]`] : kept;
}

function redactObject(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : redactValue(item, depth + 1);
  }
  return out;
}

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (isScalar(value)) return value;
  if (value instanceof Date) return value.toISOString();
  if (isBinary(value)) return REDACTED;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return redactArray(value, depth);
  if (typeof value === 'object') return redactObject(value as Record<string, unknown>, depth);
  // Functions, symbols, bigints: nothing an audit record should carry.
  return REDACTED;
}

/**
 * Redacts a metadata object.
 *
 * Always returns a plain object, so a caller passing something unexpected produces a
 * recordable value rather than an exception on the audit path.
 */
export function redactMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (metadata === undefined || metadata === null) return {};
  const redacted = redactValue(metadata, 0);
  return typeof redacted === 'object' && redacted !== null && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : { value: redacted };
}
