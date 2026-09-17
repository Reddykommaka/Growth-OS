/**
 * The audit event model.
 *
 * One shape for every audited action in the system. It is deliberately not extensible per
 * module: an audit log whose records differ in structure by origin cannot be verified,
 * queried or read by an investigator under time pressure, and the hash chain needs a single
 * canonical form to be meaningful at all.
 */

/** Which kind of principal acted. `system` is scheduled or internal work with no principal. */
export type AuditActorType = 'user' | 'api_key' | 'system';

/**
 * What happened to the attempt.
 *
 * `denied` is as important as `succeeded` and is why this is not a boolean: a refused
 * privilege escalation is the single most valuable row in the table, and a log that records
 * only successes cannot show an attack that failed.
 *
 * The distinction between the two negatives is deliberate and load-bearing for anyone
 * reading the log:
 *
 *   `denied` — a POLICY refused it. The actor was identified and was not allowed: a
 *              privilege escalation, an invitation for the wrong address, a replayed TOTP
 *              code, an auto-link the linking rules would not perform. These are the rows an
 *              investigation starts from.
 *   `failed` — the attempt did not complete for a non-authorization reason: a wrong
 *              password, a bad API-key secret, a provider error. Common and mostly noise
 *              individually; meaningful in volume.
 */
export type AuditResult = 'succeeded' | 'denied' | 'failed';

/**
 * The actor, as the audit log records it.
 *
 * `impersonatorUserId` is separate from `userId` on purpose. During impersonation the
 * EFFECTIVE actor is the impersonated user — that is whose access was used — while the
 * ORIGINAL actor is the support engineer. Collapsing them either hides who really acted or
 * misattributes the action to someone who was not there. Both are kept
 * (06-identity-and-access.md §2).
 */
export interface AuditActor {
  readonly type: AuditActorType;
  readonly userId?: string | undefined;
  readonly apiKeyId?: string | undefined;
  readonly impersonatorUserId?: string | undefined;
}

/** An event as a caller submits it. Sequence, hashes and time are assigned by the writer. */
export interface AuditEventInput {
  readonly organizationId: string;
  readonly actor: AuditActor;
  /** `<module>.<subject>.<verb>`, e.g. `organization.api_key.revoked`. */
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  /** Set when the action concerns one workspace; it is what the read policy filters on. */
  readonly workspaceId?: string | undefined;
  readonly result: AuditResult;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly requestId?: string | undefined;
  /** Redacted before it is written. Never a credential — see `redact`. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /** Overrides the clock. Only tests and backfills pass this. */
  readonly occurredAt?: Date | undefined;
}

/** A stored event, as it comes back out of the database. */
export interface AuditEventRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly sequence: number;
  readonly occurredAt: Date;
  readonly actor: AuditActor;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly workspaceId: string | null;
  readonly result: AuditResult;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly prevHash: Buffer;
  readonly hash: Buffer;
}
