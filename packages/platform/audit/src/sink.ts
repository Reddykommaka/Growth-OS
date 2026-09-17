/**
 * The port application services write through.
 *
 * Owned here rather than redeclared per module. Two identical copies already existed in
 * `identity` and `organization`, and a third would have appeared with the next module — at
 * which point they drift, and a log whose records differ in structure by origin cannot be
 * verified or queried.
 *
 * `result` is REQUIRED, with no default. A default of 'succeeded' would silently mislabel
 * every refusal a caller forgot to mark, and refusals are the rows that matter most: a
 * denied privilege escalation is the most valuable entry in the table. Requiring it makes
 * the compiler ask the question at all 38 call sites rather than trusting each author to
 * remember.
 */

import type { AuditActor, AuditResult } from './event.js';

/**
 * The reserved chain for security events that precede any tenant.
 *
 * A failed sign-in against an unknown address has no organization, and dropping it would
 * leave the log silent about exactly the period an intrusion looks like. No tenant session
 * can read this chain — see migration 0011.
 */
export const PLATFORM_ORGANIZATION_ID = '01900000-0000-7000-8000-0000000000fe';

export interface AuditEntry {
  /** Omit only when the action genuinely has no tenant; it then joins the platform chain. */
  readonly organizationId?: string | undefined;
  readonly actor: AuditActor;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly workspaceId?: string | undefined;
  readonly result: AuditResult;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly requestId?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}

/** Convenience for the common case: a human actor, acting on their own behalf. */
export function userActor(
  userId: string | null,
  impersonatorUserId?: string | undefined,
): AuditActor {
  if (userId === null) return { type: 'system' };
  return {
    type: 'user',
    userId,
    ...(impersonatorUserId === undefined ? {} : { impersonatorUserId }),
  };
}

/** A machine actor. The key is named; there is no user behind it. */
export function apiKeyActor(apiKeyId: string): AuditActor {
  return { type: 'api_key', apiKeyId };
}
