/**
 * The credential-resolution unit of work.
 *
 * Invitation acceptance and API-key authentication share one shape: a stranger presents a
 * string, and the string is the only thing that says which tenant it concerns. Both must
 * therefore open a transaction for an organization NAMED BY UNTRUSTED INPUT, and both are
 * safe for the same reason — naming an organization is not being granted it (ADR-0018).
 *
 * What makes it safe, concretely:
 *
 *   - the connection is growth_os_app, NOBYPASSRLS, as everywhere else. Every statement
 *     inside is still checked against `organization_id = <the named tenant>`;
 *   - the workspace set is EMPTY and the scope is 'set', so workspace-scoped tables return
 *     nothing at all. This transaction can reach tenancy and credential rows and no tenant
 *     content, which is exactly what resolving a credential needs;
 *   - the first query of each caller is the one that authorises: a token hash for
 *     acceptance, a key prefix plus Argon2 for authentication. Neither can be satisfied by
 *     choosing a different organization.
 *
 * One transaction, one connection, shared by every repository the body uses — so acceptance
 * reads the invitation, consumes it and writes the membership atomically.
 */

import { withOrganizationScope } from '@growth-os/db';
import type { Pool, PoolClient } from 'pg';
import type { TenantScopedRepositories, TenantScopeFactory } from '../application/ports.js';
import { createApiKeyRepository } from './api-key-repository.js';
import {
  createInvitationRepository,
  createMembershipWriter,
  createRoleReader,
  createWorkspaceTopologyReader,
} from './invitation-repository.js';

function repositories(client: PoolClient): TenantScopedRepositories {
  return {
    invitations: createInvitationRepository(client),
    roles: createRoleReader(client),
    memberships: createMembershipWriter(client),
    apiKeys: createApiKeyRepository(client),
    topology: createWorkspaceTopologyReader(client),
  };
}

export function createTenantScopeFactory(pool: Pool): TenantScopeFactory {
  return {
    async withoutWorkspaceReach(organizationId, reason, body) {
      return await withOrganizationScope(
        pool,
        organizationId,
        // 'set' with the empty set. Invitation acceptance reads one row keyed by a token
        // hash and writes organization-scoped membership; it has no business seeing
        // workspace-scoped rows, and saying so here is what keeps it from being able to.
        { reason, workspaceScope: 'set' },
        async (client) => await body(repositories(client)),
      );
    },

    async withOrganizationWideWorkspaceReach(organizationId, reason, body) {
      return await withOrganizationScope(
        pool,
        organizationId,
        // 'all', for the same reason the actor resolver claims it: the caller is computing
        // an accessible-workspace SET, and a policy that demands the set makes the set
        // underivable (migration 0007). Confined to this one organization, and to reading
        // workspace ids.
        { reason, workspaceScope: 'all' },
        async (client) => await body(repositories(client)),
      );
    },
  };
}
