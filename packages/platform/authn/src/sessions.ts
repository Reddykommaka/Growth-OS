/**
 * Session lifetime and cookie policy (06-identity-and-access.md §2).
 *
 * Pure policy: no database, no framework. The rules live here so they are stated once and
 * testable without a server, and the identity module applies them.
 */
import { type IssuedToken, issueToken } from './tokens.js';

/** Sliding 30 days, absolute 90 — both, so renewal can never outrun the ceiling. */
export const SESSION_SLIDING_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How stale a session may be before a sensitive action requires re-authentication.
 *
 * "Sensitive" is the same set the impersonation denial list covers: credentials, money,
 * and anything that grants access to either.
 */
export const REAUTH_WINDOW_MS = 15 * 60 * 1000;

/** Renew no more often than this, so an active session is not one write per request. */
export const SESSION_RENEW_THRESHOLD_MS = 60 * 60 * 1000;

export interface NewSession extends IssuedToken {
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export function startSession(now: Date): NewSession {
  const issued = issueToken();
  return {
    ...issued,
    expiresAt: new Date(now.getTime() + SESSION_SLIDING_MS),
    absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
  };
}

export interface SessionRecord {
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
  readonly mfaSatisfiedAt: Date | null;
  readonly impersonationExpiresAt?: Date | null;
}

export type SessionState =
  | 'active'
  | 'expired'
  | 'revoked'
  | 'absolute_expired'
  | 'impersonation_expired';

/**
 * Classifies a session.
 *
 * Revocation is checked FIRST and separately from expiry. Firing an employee must end their
 * access now, and a revoked-but-unexpired session reading as active for even one request is
 * the failure that makes session storage worth its cost over a JWT (06 §2).
 */
export function sessionState(session: SessionRecord, now: Date): SessionState {
  if (session.revokedAt !== null && session.revokedAt <= now) return 'revoked';
  if (session.absoluteExpiresAt <= now) return 'absolute_expired';
  if (session.expiresAt <= now) return 'expired';
  if (
    session.impersonationExpiresAt !== null &&
    session.impersonationExpiresAt !== undefined &&
    session.impersonationExpiresAt <= now
  ) {
    return 'impersonation_expired';
  }
  return 'active';
}

/**
 * The new sliding expiry, or undefined when the session is fresh enough to leave alone.
 *
 * Clamped to the absolute ceiling: a session used daily for a year must still end at 90
 * days, or "absolute" means nothing.
 */
export function renewedExpiry(session: SessionRecord, now: Date): Date | undefined {
  const remaining = session.expiresAt.getTime() - now.getTime();
  if (remaining > SESSION_SLIDING_MS - SESSION_RENEW_THRESHOLD_MS) return undefined;
  const proposed = now.getTime() + SESSION_SLIDING_MS;
  const capped = Math.min(proposed, session.absoluteExpiresAt.getTime());
  return new Date(capped);
}

/** Whether a sensitive action may proceed, or the actor must re-authenticate first. */
export function requiresReauthentication(session: SessionRecord, now: Date): boolean {
  if (session.mfaSatisfiedAt === null) return true;
  return now.getTime() - session.mfaSatisfiedAt.getTime() > REAUTH_WINDOW_MS;
}

/** Impersonation is time-boxed at 60 minutes (06 §2). */
export const MAX_IMPERSONATION_MS = 60 * 60 * 1000;

export function impersonationExpiry(now: Date, requestedMs?: number): Date {
  const bounded = Math.min(requestedMs ?? MAX_IMPERSONATION_MS, MAX_IMPERSONATION_MS);
  return new Date(now.getTime() + Math.max(bounded, 0));
}

export interface CookieOptions {
  readonly name: string;
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: 'lax';
  readonly path: '/';
  readonly maxAge: number;
}

/**
 * The session cookie.
 *
 * `__Host-` is not decoration: the prefix is enforced by the browser and REQUIRES Secure,
 * Path=/ and no Domain attribute. That last part is the point — it makes the cookie
 * un-settable by a subdomain, so an XSS on a customer-controlled subdomain cannot plant a
 * session for the apex.
 *
 * SameSite=Lax rather than Strict so that following a link from an email lands signed in;
 * CSRF is handled by token rather than by making the product feel broken.
 */
export function sessionCookie(maxAgeSeconds = SESSION_SLIDING_MS / 1000): CookieOptions {
  return {
    name: '__Host-growth_os_session',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}
