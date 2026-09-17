/**
 * The identity unit of work, over a real connection.
 *
 * `withoutTenantContext` is the transaction: identity tables are global and carry no tenant
 * column, so there is no `app.*` context to set. That primitive already exists, is already
 * conspicuous by name, and is already pinned by an architecture test — which is why this is a
 * binding rather than a second transaction mechanism.
 *
 * The audit sink is bound to the same client and is told to REQUIRE a transaction. Identity
 * now has one, so an audit row committing on its own would be a defect rather than the best
 * available behaviour, and the sink turns that into a loud failure instead of a silent
 * decoupling discovered during an incident.
 */

import type { AuditQueryable, AuditSink } from '@growth-os/audit';
import { createAuditSink } from '@growth-os/audit';
import { withoutTenantContext } from '@growth-os/db';
import type { Pool } from 'pg';
import type { IdentityRepositories, IdentityUnitOfWork } from '../application/unit-of-work.js';
import { createMfaRepository } from './mfa-repository.js';
import { createOAuthRequestRepository, createUserIdentityRepository } from './oauth-repository.js';
import { createSessionRepository } from './session-repository.js';
import { createUserRepository } from './user-repository.js';
import { createUserTokenRepository } from './user-token-repository.js';

export interface IdentityUnitOfWorkOptions {
  /** Overrides the audit clock. Only tests pass this. */
  readonly now?: (() => Date) | undefined;
  /**
   * Supplies the audit sink instead of the hash-chained one.
   *
   * Exists for suites that assert on audit CONTENT — what action, what actor, which fields
   * are absent — a concern orthogonal to transactionality. They keep an in-memory recorder
   * while still running inside a real transaction, so their assertions stay meaningful and
   * the unit of work under them is the production one.
   *
   * Production passes nothing and gets the real sink. There is one code path either way:
   * a separate "test unit of work" would be a second implementation of the thing being
   * tested, which is how the two drift.
   */
  readonly auditSink?: ((client: AuditQueryable) => AuditSink) | undefined;
}

export function createIdentityUnitOfWork(
  pool: Pool,
  options: IdentityUnitOfWorkOptions = {},
): IdentityUnitOfWork {
  return {
    async transaction(reason, body) {
      return await withoutTenantContext(pool, reason, async (client) => {
        const repositories: IdentityRepositories = {
          users: createUserRepository(client),
          tokens: createUserTokenRepository(client),
          sessions: createSessionRepository(client),
          mfa: createMfaRepository(client),
          identities: createUserIdentityRepository(client),
          oauthRequests: createOAuthRequestRepository(client),
          audit:
            options.auditSink?.(client) ??
            createAuditSink(client, {
              ...(options.now === undefined ? {} : { now: options.now }),
              requireTransaction: true,
            }),
        };
        return await body(repositories);
      });
    },
  };
}
