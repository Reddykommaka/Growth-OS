/**
 * Redaction.
 *
 * 10-security-architecture.md §2: secrets must be stripped **at the serializer**, not at
 * each call site. A control that depends on every developer remembering is not a control.
 * By redacting during serialisation, a credential cannot reach a log sink even when it
 * reaches a log call.
 */

/** Key names whose values are replaced wholesale, matched case-insensitively. */
export const REDACTED_KEYS: readonly string[] = [
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'secret',
  'clientSecret',
  'client_secret',
  'apiKey',
  'api_key',
  'apiSecret',
  'authorization',
  'cookie',
  'setCookie',
  'set-cookie',
  'sessionToken',
  'session_token',
  'privateKey',
  'private_key',
  'signature',
  'otp',
  'totpSecret',
  'mfaSecret',
  'recoveryCode',
  'creditCard',
  'cardNumber',
  'cvv',
  'ssn',
];

export const REDACTED = '[redacted]';

const NORMALISED = new Set(REDACTED_KEYS.map((k) => k.toLowerCase().replace(/[_-]/g, '')));

export const isSensitiveKey = (key: string): boolean =>
  NORMALISED.has(key.toLowerCase().replace(/[_-]/g, ''));

/**
 * Values that look like credentials regardless of the key they arrive under — a bearer
 * token pasted into a `message`, a provider key inside an error string.
 */
const VALUE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\bBasic\s+[A-Za-z0-9+/]{16,}=*/gi,
  /\bgos_(?:live|test)_[A-Za-z0-9_-]{8,}/g, // our own API key format
  /\bsk-[A-Za-z0-9_-]{16,}/g, // common provider secret-key shape
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bghp_[A-Za-z0-9]{20,}/g, // GitHub
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
];

export function redactString(value: string): string {
  let out = value;
  for (const pattern of VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

const MAX_DEPTH = 8;

/**
 * Recursively redacts a value. Cycles are handled, depth is bounded, and unknown object
 * shapes are traversed rather than trusted — a secret nested three levels inside a provider
 * response must not survive because nobody anticipated that shape.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack === undefined ? undefined : redactString(value.stack),
    };
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return out;
}
