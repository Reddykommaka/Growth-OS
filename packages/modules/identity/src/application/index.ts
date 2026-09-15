/**
 * @growth-os/module-identity/application
 *
 * The identity services. Every one takes its dependencies as ports, so the rules are
 * testable without a database — and the parts that genuinely need one (uniqueness,
 * single-use tokens, replay guards) are tested against a real cluster rather than a fake.
 */
export {
  type ConfirmEnrolmentResult,
  completeMfaChallenge,
  confirmTotpEnrolment,
  disableMfa,
  type EnrolmentStart,
  type MfaChallengeOutcome,
  type MfaDependencies,
  regenerateRecoveryCodes,
  startTotpEnrolment,
} from './mfa.js';
export type {
  AuditEvent,
  AuditSink,
  AuthRateLimiter,
  Clock,
  CreateSessionInput,
  CreateUserInput,
  MfaCredentialRow,
  MfaRepository,
  SessionRecordRow,
  SessionRepository,
  UserRecord,
  UserRepository,
  UserTokenRepository,
  UserTokenRow,
} from './ports.js';
export { systemClock } from './ports.js';
export {
  type ChangePasswordInput,
  changePassword,
  completePasswordReset,
  type PasswordResetOutcome,
  type PasswordResetRequest,
  type RegisterInput,
  type RegisterResult,
  type RegistrationDependencies,
  register,
  requestPasswordReset,
  resendVerification,
  type VerificationOutcome,
  verifyEmail,
} from './registration.js';
export {
  type AuthenticatedSession,
  authenticateSession,
  listSessions,
  type SessionLookup,
  type SignInDependencies,
  type SignInInput,
  type SignInResult,
  signIn,
  signOut,
  signOutEverywhere,
} from './sign-in.js';
