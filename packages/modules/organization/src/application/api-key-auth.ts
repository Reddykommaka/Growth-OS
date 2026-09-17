/**
 * Authenticating a presented API key.
 *
 * Separate from creating one for the same reason invitation acceptance is separate from
 * issuing an invitation: the two have opposite starting points. Creation begins with a
 * resolved actor inside a tenant; authentication begins with a string, and must work out
 * which tenant that string refers to before it can read anything (ADR-0018).
 */

import { userActor } from '@growth-os/audit';
import { organizationIdFromApiKeyPrefix, parseApiKey, verifyPassword } from '@growth-os/authn';
import {
  type ActorContext,
  grantsOrganizationWideWorkspaceAccess,
  type Permission,
  resolveAccessibleWorkspaces,
} from '@growth-os/authz';
import type {
  ApiKeyRow,
  AuditSink,
  Clock,
  RateLimiter,
  TenantScopedRepositories,
  TenantScopeFactory,
} from './ports.js';

/**
 * Authentication dependencies.
 *
 * Like invitation acceptance, this path has no actor and no tenant context when it starts,
 * so it opens its own scope from the tenant the key names rather than being handed
 * repositories already bound to one.
 */
export interface ApiKeyAuthDependencies {
  readonly scope: TenantScopeFactory;
  readonly audit: AuditSink;
  readonly clock: Clock;
  readonly rateLimiter?: RateLimiter | undefined;
}

export type ApiKeyAuthResult =
  | { readonly ok: true; readonly actor: ActorContext; readonly keyId: string }
  | {
      readonly ok: false;
      readonly reason:
        | 'malformed'
        | 'unknown'
        | 'bad_secret'
        | 'revoked'
        | 'expired'
        | 'rate_limited';
    };

/**
 * Authenticates a presented key and builds its actor context.
 *
 * The key's prefix names its organization, which is what lets this run before any tenant
 * context exists; the row is then read INSIDE that organization's scope, so the RLS policy
 * is what confirms the key belongs to the tenant it claims (ADR-0018). A forged prefix opens
 * a scope in which no row matches.
 *
 * The context is deliberately built the same way a user's is, through
 * `resolveAccessibleWorkspaces`, so the key inherits the SAME workspace-set semantics and
 * the same RLS behaviour. A key narrowed to one workspace intersects rather than unions —
 * it cannot widen itself through whatever its creator could reach.
 */
export async function authenticateApiKey(
  deps: ApiKeyAuthDependencies,
  presented: string,
  ip?: string,
): Promise<ApiKeyAuthResult> {
  if (deps.rateLimiter !== undefined) {
    const allowed = await deps.rateLimiter.consume(`apikey:${ip ?? 'unknown'}`);
    if (!allowed) return { ok: false, reason: 'rate_limited' };
  }

  const parsed = parseApiKey(presented);
  if (parsed === undefined) return { ok: false, reason: 'malformed' };

  const organizationId = organizationIdFromApiKeyPrefix(parsed.prefix);
  // A prefix that names no organization is malformed, not unknown — and both are refused
  // identically, so the shape of a key is never an oracle.
  if (organizationId === undefined) return { ok: false, reason: 'malformed' };

  // Organization-wide workspace reach, because an un-narrowed key spans its organization
  // and the engine checks reachability against a materialised list. See the port.
  return await deps.scope.withOrganizationWideWorkspaceReach(
    organizationId,
    'api key authentication',
    async (repos) => await verifyPresentedKey(deps, repos, parsed, ip),
  );
}

async function verifyPresentedKey(
  deps: ApiKeyAuthDependencies,
  repos: TenantScopedRepositories,
  parsed: { readonly prefix: string; readonly secret: string },
  ip?: string,
): Promise<ApiKeyAuthResult> {
  const row = await repos.apiKeys.findByPrefix(parsed.prefix);
  if (row === undefined) {
    // A full Argon2 verification against a dummy hash would be ideal here for the same
    // timing reason as sign-in. The prefix's random half is unguessable, so an unknown
    // prefix discloses nothing an attacker can act on.
    return { ok: false, reason: 'unknown' };
  }

  if (!(await verifyPassword(row.keyHash, parsed.secret))) {
    await deps.audit.record({
      action: 'organization.api_key.auth_failed',
      result: 'failed',
      actor: userActor(null),
      organizationId: row.organizationId,
      resourceType: 'api_key',
      resourceId: row.id,
      ...(ip === undefined ? {} : { ip }),
      // The prefix, never the secret and never the hash.
      metadata: { reason: 'bad_secret', prefix: row.prefix },
    });
    return { ok: false, reason: 'bad_secret' };
  }

  const now = deps.clock.now();
  if (row.revokedAt !== null && row.revokedAt <= now) return { ok: false, reason: 'revoked' };
  if (row.expiresAt !== null && row.expiresAt <= now) return { ok: false, reason: 'expired' };

  const actor = await buildKeyActor(repos, row);
  // Best-effort and non-blocking on failure: last-used tracking must never be the reason a
  // valid request is refused.
  await repos.apiKeys.touch(row.id, now).catch(() => undefined);

  return { ok: true, actor, keyId: row.id };
}

async function buildKeyActor(
  repos: TenantScopedRepositories,
  row: ApiKeyRow,
): Promise<ActorContext> {
  // The key's scopes ARE its permissions, granted at organization scope. The engine then
  // checks the scope list a SECOND time for a machine actor, so both must agree — a key
  // cannot act on a permission it does not carry even if some assignment would allow it.
  const assignment = {
    roleId: `api_key:${row.id}`,
    permissions: row.scopes as readonly Permission[],
  };

  const all = await repos.topology.allWorkspaceIds(row.organizationId);
  const resolved = resolveAccessibleWorkspaces({
    directWorkspaceIds: [],
    teamIds: [],
    workspacesOwnedByTeam: new Map(),
    workspacesGrantedToTeam: new Map(),
    allOrganizationWorkspaceIds: all,
    hasOrganizationScopedRole: grantsOrganizationWideWorkspaceAccess([assignment]),
    ...(row.workspaceId === null ? {} : { restrictToWorkspaceId: row.workspaceId }),
  });

  return {
    kind: 'api_key',
    apiKeyId: row.id,
    organizationId: row.organizationId,
    organizationStatus: 'active',
    assignments: [assignment],
    resourceGrants: [],
    accessibleWorkspaceIds: resolved.workspaceIds,
    workspaceScope: resolved.workspaceScope,
    teamIds: [],
    workspacesByTeam: new Map(),
    // A machine actor has no second factor and no session to re-authenticate. Sensitive
    // permissions are withheld by SCOPE instead — a key is never granted one it was not
    // explicitly created with.
    mfaSatisfied: true,
    mfaRequired: false,
    impersonated: false,
    apiKeyScopes: row.scopes,
    ...(row.workspaceId === null ? {} : { apiKeyWorkspaceId: row.workspaceId }),
  } satisfies ActorContext;
}
