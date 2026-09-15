/**
 * Ports the identity services depend on.
 *
 * `pg` is banned from application/ by the boundary rules, so persistence arrives as an
 * interface and infrastructure/ supplies it. The practical payoff is that every rule below
 * is testable without a database — and that the parts which genuinely need one (RLS,
 * uniqueness, transactionality) are tested against a real cluster rather than a fake.
 */
import type { UserStatus, UserTokenPurpose } from '../domain/index.js';

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string | null;
  readonly status: UserStatus;
  readonly name: string | null;
  readonly mfaEnabled: boolean;
  readonly emailVerifiedAt: Date | null;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
}

export interface CreateUserInput {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string | null;
  readonly name?: string | undefined;
  readonly status: UserStatus;
}

export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | undefined>;
  findById(id: string): Promise<UserRecord | undefined>;
  create(input: CreateUserInput): Promise<UserRecord>;
  updateLockout(
    userId: string,
    state: { failedLoginCount: number; lockedUntil: Date | null },
  ): Promise<void>;
  markSignedIn(userId: string, at: Date): Promise<void>;
  markEmailVerified(userId: string, at: Date): Promise<void>;
  setPasswordHash(userId: string, passwordHash: string): Promise<void>;
  setMfaEnabled(userId: string, enabled: boolean): Promise<void>;
  setStatus(userId: string, status: UserStatus): Promise<void>;
  setEmail(userId: string, email: string, verifiedAt: Date): Promise<void>;
}

export interface SessionRecordRow {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
  readonly mfaSatisfiedAt: Date | null;
  readonly impersonatorUserId: string | null;
  readonly impersonationExpiresAt: Date | null;
  readonly activeOrganizationId: string | null;
  readonly deviceLabel: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly lastUsedAt: Date;
  readonly createdAt: Date;
}

export interface CreateSessionInput {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: Buffer;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly mfaSatisfiedAt: Date | null;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly deviceLabel?: string | undefined;
  readonly impersonatorUserId?: string | undefined;
  readonly impersonationReason?: string | undefined;
  readonly impersonationExpiresAt?: Date | undefined;
}

export interface SessionRepository {
  create(input: CreateSessionInput): Promise<SessionRecordRow>;
  findByTokenHash(tokenHash: Buffer): Promise<SessionRecordRow | undefined>;
  touch(sessionId: string, at: Date, expiresAt?: Date): Promise<void>;
  revoke(sessionId: string, at: Date, reason: string): Promise<void>;
  revokeAllForUser(
    userId: string,
    at: Date,
    reason: string,
    exceptSessionId?: string,
  ): Promise<number>;
  listForUser(userId: string): Promise<SessionRecordRow[]>;
  recordMfaSatisfied(sessionId: string, at: Date): Promise<void>;
  setActiveOrganization(sessionId: string, organizationId: string): Promise<void>;
}

export interface UserTokenRow {
  readonly id: string;
  readonly userId: string;
  readonly purpose: UserTokenPurpose;
  readonly newEmail: string | null;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface UserTokenRepository {
  create(input: {
    readonly id: string;
    readonly userId: string;
    readonly purpose: UserTokenPurpose;
    readonly tokenHash: Buffer;
    readonly expiresAt: Date;
    readonly newEmail?: string | undefined;
  }): Promise<void>;
  findUnconsumed(purpose: UserTokenPurpose, tokenHash: Buffer): Promise<UserTokenRow | undefined>;
  /**
   * Marks a token consumed, returning false if it was ALREADY consumed.
   *
   * Single-use has to be decided by the write, not by a prior read: two requests presenting
   * the same token can both pass a read-then-write check. The implementation makes this a
   * conditional UPDATE so the database settles the race.
   */
  consume(tokenId: string, at: Date): Promise<boolean>;
  invalidateAllFor(userId: string, purpose: UserTokenPurpose, at: Date): Promise<number>;
}

export interface MfaCredentialRow {
  readonly id: string;
  readonly userId: string;
  readonly type: 'totp' | 'webauthn';
  readonly label: string | null;
  readonly secretEncrypted: Buffer | null;
  readonly confirmedAt: Date | null;
  readonly lastUsedAt: Date | null;
  /** The last accepted TOTP counter, so a code cannot be replayed within its period. */
  readonly lastCounter: string | null;
}

export interface MfaRepository {
  createTotp(input: {
    readonly id: string;
    readonly userId: string;
    readonly secretEncrypted: Buffer;
    readonly label?: string | undefined;
  }): Promise<void>;
  findTotpForUser(userId: string): Promise<MfaCredentialRow | undefined>;
  confirm(credentialId: string, at: Date, counter: bigint): Promise<void>;
  recordUse(credentialId: string, at: Date, counter: bigint): Promise<boolean>;
  deleteForUser(userId: string): Promise<void>;
  replaceRecoveryCodes(userId: string, hashes: readonly Buffer[]): Promise<void>;
  consumeRecoveryCode(userId: string, codeHash: Buffer, at: Date): Promise<boolean>;
  countUnusedRecoveryCodes(userId: string): Promise<number>;
}

/**
 * Audit sink.
 *
 * A port rather than a direct dependency so the identity services stay testable, and so the
 * hash-chained implementation in platform/audit can be swapped in without touching them.
 */
export interface AuditEvent {
  readonly action: string;
  readonly actorUserId: string | null;
  readonly organizationId?: string | undefined;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly ip?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

/**
 * Rate limiting for authentication endpoints.
 *
 * Separate from the per-account lockout: lockout stops one account being guessed, this stops
 * one source spraying a common password across many accounts — which lockout never sees,
 * because each account only fails once.
 */
export interface AuthRateLimiter {
  /** Returns false when the caller should be refused without the attempt being made. */
  consume(key: string): Promise<boolean>;
  reset(key: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
