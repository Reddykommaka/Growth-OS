/**
 * @growth-os/authn — authentication primitives.
 *
 * Credentials, tokens, TOTP and session policy. Deliberately free of database and framework:
 * the identity module applies these rules, and keeping them separable is what lets them be
 * tested exhaustively without a server.
 */

export { base32Decode, base32Encode } from './encoding.js';
export {
  ARGON2_OPTIONS,
  type BreachedPasswordCheck,
  DEFAULT_PASSWORD_POLICY,
  type HashPasswordOptions,
  hashPassword,
  needsRehash,
  type PasswordPolicy,
  verifyPassword,
} from './password.js';
export {
  createSecretCipher,
  generateSecretKey,
  type SecretCipher,
  secretEquals,
} from './secret-box.js';
export {
  type CookieOptions,
  impersonationExpiry,
  MAX_IMPERSONATION_MS,
  type NewSession,
  REAUTH_WINDOW_MS,
  renewedExpiry,
  requiresReauthentication,
  SESSION_ABSOLUTE_MS,
  SESSION_RENEW_THRESHOLD_MS,
  SESSION_SLIDING_MS,
  type SessionRecord,
  type SessionState,
  sessionCookie,
  sessionState,
  startSession,
} from './sessions.js';
export {
  API_KEY_PREFIX_BYTES,
  API_KEY_SECRET_BYTES,
  hashRecoveryCode,
  hashToken,
  type IssuedApiKey,
  type IssuedToken,
  issueApiKey,
  issueRecoveryCode,
  issueToken,
  normaliseRecoveryCode,
  type ParsedApiKey,
  parseApiKey,
  tokenHashEquals,
} from './tokens.js';
export {
  generateTotp,
  generateTotpSecret,
  type TotpAlgorithm,
  type TotpOptions,
  totpCounterFor,
  totpUri,
  type VerifyTotpOptions,
  verifyTotp,
} from './totp.js';
