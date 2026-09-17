/**
 * The identity unit of work.
 *
 * Identity repositories are built over a `Queryable`, which both a Pool and a PoolClient
 * satisfy — so until now every service ran each write as its own implicit transaction. That
 * is not merely untidy; several identity operations are multi-write sequences whose halves
 * are useless or dangerous apart:
 *
 *   - `verifyEmail` consumes the token and THEN marks the address verified. A crash between
 *     them leaves a consumed token and an unverified user, who can never verify again.
 *   - `completePasswordReset` consumes the token, sets the hash, clears the lockout and
 *     revokes every session. Stopping after the hash leaves the old sessions live — the
 *     attacker's session survives the victim's password change.
 *   - `confirmTotpEnrolment` confirms the credential, flags the user and writes the recovery
 *     codes. Stopping early leaves MFA half-on: a credential that exists while the user is
 *     not flagged, or a flagged user with no recovery codes.
 *   - and every one of them owes an audit event that must commit with the change
 *     (05-data-architecture.md §9).
 *
 * WHY THIS IS NOT A SECOND TRANSACTION ABSTRACTION. It is a thin port over
 * `withoutTenantContext`, which is the approved primitive for the untenanted path and the one
 * an architecture test already pins. Identity tables are global — no tenant column, no RLS
 * (05 §3 level 1) — so there is no tenant context to set, and inventing one here would be the
 * duplication worth avoiding. The port exists so the application layer can express "these
 * writes are one unit" without importing `pg`.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER. Reads. `authenticateSession` and `listSessions` are
 * read paths whose single incidental write (`sessions.touch`) is already atomic as one
 * statement, and wrapping them would take a connection out of the pool for every
 * authenticated request to buy nothing.
 */

import type { AuditSink } from '@growth-os/audit';
import type { OAuthRequestRepository, UserIdentityRepository } from './oauth-port.js';
import type {
  MfaRepository,
  SessionRepository,
  UserRepository,
  UserTokenRepository,
} from './ports.js';

/**
 * Every identity repository, rebound to one transaction.
 *
 * Bundled rather than passed one by one because they must all read and write the SAME
 * transaction: a repository built over the pool inside a unit of work would commit
 * independently, which is the failure this exists to prevent — and it would look correct.
 */
export interface IdentityRepositories {
  readonly users: UserRepository;
  readonly tokens: UserTokenRepository;
  readonly sessions: SessionRepository;
  readonly mfa: MfaRepository;
  readonly identities: UserIdentityRepository;
  readonly oauthRequests: OAuthRequestRepository;
  /**
   * The audit sink bound to the same transaction.
   *
   * This is the whole point of the unit of work: the security record commits with the change
   * it describes, or neither does.
   */
  readonly audit: AuditSink;
}

export interface IdentityUnitOfWork {
  /**
   * Runs a body as one atomic unit.
   *
   * `reason` is stated at the call site for the same purpose as `withoutTenantContext`'s:
   * every transaction on the untenanted path says in the call why it is there.
   *
   * NEVER hold one of these open across a network call. OAuth's token exchange happens
   * between two separate units of work on purpose — the authorization request is consumed and
   * committed first, so a replayed callback loses even when the exchange then fails, and the
   * provider's latency never pins a connection.
   */
  transaction<T>(
    reason: string,
    body: (repositories: IdentityRepositories) => Promise<T>,
  ): Promise<T>;
}

/**
 * Rebinds a service's dependencies onto one transaction.
 *
 * Only the keys the bundle actually declares are replaced, so `RegistrationDependencies`
 * keeps its clock and gains transaction-bound users, tokens, sessions and audit, while never
 * acquiring the OAuth repositories it has no business touching.
 *
 * Doing it this way means the service BODIES are unchanged: they still receive the shape they
 * were written against, and the atomicity comes from what that shape is bound to. A rewrite
 * that threaded a client through every helper would have been a much larger diff across code
 * whose logic is not what is changing.
 */
export function bindToTransaction<D extends object>(
  deps: D,
  repositories: IdentityRepositories,
): D {
  const bound = { ...deps } as Record<string, unknown>;
  for (const key of Object.keys(repositories)) {
    if (key in deps) bound[key] = repositories[key as keyof IdentityRepositories];
  }
  return bound as D;
}
