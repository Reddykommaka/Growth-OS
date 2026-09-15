/**
 * The API-key wiring the key suites share.
 *
 * `authenticate` takes the key string and nothing else — no organization — because the
 * production surface takes nothing else. The tenant comes from the key's own prefix and the
 * RLS policy decides whether the row is really there (ADR-0018). Writing that once is what
 * keeps a later file from passing an organization in and proving less than it appears to.
 */

import { withTenant } from '@growth-os/db';
import type { PoolClient } from 'pg';
import {
  type ApiKeyAuthDependencies,
  type ApiKeyDependencies,
  authenticateApiKey,
  createApiKey,
} from '../application/index.js';
import { createApiKeyRepository } from '../infrastructure/api-key-repository.js';
import { createWorkspaceTopologyReader } from '../infrastructure/invitation-repository.js';
import { createTenantScopeFactory } from '../infrastructure/tenant-scope.js';
import type { AgencyFixture, Recorder } from './agency-fixture.js';

export interface ApiKeyHarness {
  readonly authDeps: ApiKeyAuthDependencies;
  /** Repositories bound to one transaction, for the actor-driven services. */
  deps(client: PoolClient): ApiKeyDependencies;
  /** Key creation runs inside the creator's tenant context, as production would. */
  mint(
    userId: string,
    input: Omit<Parameters<typeof createApiKey>[1], 'actor'>,
    organizationId?: string,
  ): Promise<Awaited<ReturnType<typeof createApiKey>>>;
  authenticate(key: string, ip?: string): Promise<Awaited<ReturnType<typeof authenticateApiKey>>>;
  /** Runs an actor-driven key service (revoke, rotate, list) in the actor's own context. */
  asOwner<T>(userId: string, body: (deps: ApiKeyDependencies) => Promise<T>): Promise<T>;
}

export function createApiKeyHarness(fx: AgencyFixture, recorder: Recorder): ApiKeyHarness {
  const deps = (client: PoolClient): ApiKeyDependencies => ({
    apiKeys: createApiKeyRepository(client),
    topology: createWorkspaceTopologyReader(client),
    audit: recorder.audit,
    clock: recorder.clock,
  });

  const authDeps: ApiKeyAuthDependencies = {
    // Authentication takes NO repositories: it opens its own scope from the tenant the key
    // names, exactly as production does.
    scope: createTenantScopeFactory(fx.db.pool),
    audit: recorder.audit,
    clock: recorder.clock,
  };

  const inContext = async <T>(
    userId: string,
    organizationId: string,
    body: (d: ApiKeyDependencies) => Promise<T>,
  ): Promise<T> => {
    const ctx = await fx.actorFor(userId, organizationId);
    return await withTenant(
      fx.db.pool,
      {
        organizationId,
        userId,
        workspaceIds: ctx.accessibleWorkspaceIds,
        workspaceScope: ctx.workspaceScope,
      },
      async (tx) => await body(deps(tx.client)),
    );
  };

  return {
    authDeps,
    deps,
    async mint(userId, input, organizationId = fx.agencyOrg) {
      const ctx = await fx.actorFor(userId, organizationId);
      return await inContext(
        userId,
        organizationId,
        async (d) => await createApiKey(d, { ...input, actor: ctx }),
      );
    },
    async authenticate(key, ip) {
      return await authenticateApiKey(authDeps, key, ip);
    },
    async asOwner(userId, body) {
      return await inContext(userId, fx.agencyOrg, body);
    },
  };
}
