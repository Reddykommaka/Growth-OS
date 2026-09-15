/**
 * API keys.
 *
 * A key is a machine actor scoped to ONE organization, optionally narrowed to one workspace.
 * It is never a way around tenancy: the ActorContext it produces goes through exactly the
 * same authorization engine and the same RLS predicates as a human session, and the key's
 * own organization is the only one it can name.
 *
 * The secret is shown once and is unrecoverable. Rotation is therefore the only remedy for a
 * leak, which is deliberate — a key that can be re-read is a key that lives in a support
 * ticket forever.
 */

import { randomUUID } from 'node:crypto';
import {
  hashPassword,
  issueApiKey,
  organizationIdFromApiKeyPrefix,
  parseApiKey,
  verifyPassword,
} from '@growth-os/authn';
import {
  type ActorContext,
  assertPermission,
  grantsOrganizationWideWorkspaceAccess,
  PERMISSIONS,
  type Permission,
  resolveAccessibleWorkspaces,
} from '@growth-os/authz';
import { ValidationError } from '@growth-os/errors';
import type {
  ApiKeyRepository,
  ApiKeyRow,
  AuditSink,
  Clock,
  RateLimiter,
  TenantScopedRepositories,
  TenantScopeFactory,
  WorkspaceTopologyReader,
} from './ports.js';

export interface ApiKeyDependencies {
  readonly apiKeys: ApiKeyRepository;
  readonly topology: WorkspaceTopologyReader;
  readonly audit: AuditSink;
  readonly clock: Clock;
  readonly rateLimiter?: RateLimiter | undefined;
}

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

export interface CreateApiKeyInput {
  readonly actor: ActorContext;
  readonly name: string;
  /** Permission literals, or module names as a shorthand for everything in that module. */
  readonly scopes: readonly string[];
  /** Narrows the key to one workspace. Strongly preferred for an integration. */
  readonly workspaceId?: string | undefined;
  readonly expiresAt?: Date | undefined;
}

export interface CreatedApiKey {
  readonly id: string;
  readonly prefix: string;
  /**
   * The full key: `gos_live_<prefix>_<secret>`.
   *
   * Returned exactly once, at creation, and never recoverable. The caller must show it and
   * discard it; anything that persists it has defeated the design.
   */
  readonly key: string;
  readonly expiresAt: Date | null;
}

/**
 * Creates a key.
 *
 * A key may not carry a scope its creator does not hold. Otherwise `api_key:create` is a
 * promotion: mint a key with `owner`-level scopes, then act through it. Same escalation as
 * invitations, different door.
 */
export async function createApiKey(
  deps: ApiKeyDependencies,
  input: CreateApiKeyInput,
): Promise<CreatedApiKey> {
  const { actor } = input;
  assertPermission(actor, 'organization.api_key:create');

  const requested = expandScopes(input.scopes);
  if (requested.length === 0) {
    // A key with no scopes can do nothing; creating one silently is a support ticket waiting
    // to happen.
    throw new ValidationError('An API key must carry at least one scope.');
  }

  const held = new Set<string>(
    actor.assignments.flatMap((a) => [...a.permissions] as Permission[]),
  );
  const exceeding = requested.filter((p) => !held.has(p));
  if (exceeding.length > 0) {
    throw new ValidationError('An API key cannot carry permissions you do not hold.');
  }

  // A narrowed key must name a workspace its creator can actually reach.
  if (
    input.workspaceId !== undefined &&
    !actor.accessibleWorkspaceIds.includes(input.workspaceId)
  ) {
    throw new ValidationError('That workspace is not available to you.');
  }

  // The prefix embeds the organization, so authentication can name the tenant whose scope
  // to open before any context exists (ADR-0018). It stays the public half: clear in the
  // database, visible in a listing, and matchable by secret scanning.
  const issued = issueApiKey('live', actor.organizationId);
  const id = randomUUID();
  await deps.apiKeys.create({
    id,
    organizationId: actor.organizationId,
    name: input.name,
    prefix: issued.prefix,
    // Argon2, not SHA-256. The prefix is public and narrows the search space, so the secret
    // half needs a slow hash in a way an opaque session token does not.
    keyHash: await hashPassword(issued.secret, {
      policy: { minimumLength: 1, maximumLength: 1024 },
    }),
    scopes: requested,
    workspaceId: input.workspaceId ?? null,
    createdBy: actor.userId ?? null,
    expiresAt: input.expiresAt ?? null,
  });

  await deps.audit.record({
    action: 'organization.api_key.created',
    actorUserId: actor.userId ?? null,
    organizationId: actor.organizationId,
    resourceType: 'api_key',
    resourceId: id,
    // Prefix, scopes and name. Never the key, never the secret, never the hash.
    metadata: {
      prefix: issued.prefix,
      name: input.name,
      scopeCount: requested.length,
      workspaceScoped: input.workspaceId !== undefined,
    },
  });

  return { id, prefix: issued.prefix, key: issued.key, expiresAt: input.expiresAt ?? null };
}

/** Expands a module shorthand (`social`) into its permissions; passes literals through. */
function expandScopes(scopes: readonly string[]): Permission[] {
  const all = PERMISSIONS as readonly Permission[];
  const out = new Set<Permission>();
  for (const scope of scopes) {
    if (all.includes(scope as Permission)) {
      out.add(scope as Permission);
      continue;
    }
    for (const permission of all) {
      if (permission.startsWith(`${scope}.`)) out.add(permission);
    }
  }
  return [...out];
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
      actorUserId: null,
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

/** Revokes a key. Takes effect on the next request; there is no cached copy to expire. */
export async function revokeApiKey(
  deps: ApiKeyDependencies,
  actor: ActorContext,
  keyId: string,
): Promise<boolean> {
  assertPermission(actor, 'organization.api_key:revoke');
  const now = deps.clock.now();
  const revoked = await deps.apiKeys.revoke(actor.organizationId, keyId, now);
  if (revoked) {
    await deps.audit.record({
      action: 'organization.api_key.revoked',
      actorUserId: actor.userId ?? null,
      organizationId: actor.organizationId,
      resourceType: 'api_key',
      resourceId: keyId,
    });
  }
  return revoked;
}

export interface RotateApiKeyResult {
  readonly created: CreatedApiKey;
  readonly previousKeyId: string;
  readonly previousRevokedAt: Date;
}

/**
 * Rotates a key: mints a replacement carrying the same scopes and restriction, then revokes
 * the old one.
 *
 * `graceMs` keeps the old key alive briefly so a running deployment is not cut off between
 * receiving the new value and finishing its rollout. Zero revokes immediately, which is what
 * a leak calls for.
 */
export async function rotateApiKey(
  deps: ApiKeyDependencies,
  actor: ActorContext,
  keyId: string,
  graceMs = 0,
): Promise<RotateApiKeyResult> {
  assertPermission(actor, 'organization.api_key:create');
  assertPermission(actor, 'organization.api_key:revoke');

  const existing = await deps.apiKeys.findById(actor.organizationId, keyId);
  if (existing === undefined) throw new ValidationError('That API key does not exist.');

  const now = deps.clock.now();
  const created = await createApiKey(deps, {
    actor,
    name: existing.name,
    scopes: existing.scopes,
    ...(existing.workspaceId === null ? {} : { workspaceId: existing.workspaceId }),
    ...(existing.expiresAt === null ? {} : { expiresAt: existing.expiresAt }),
  });

  const revokeAt = new Date(now.getTime() + Math.max(graceMs, 0));
  await deps.apiKeys.revoke(actor.organizationId, keyId, revokeAt);

  await deps.audit.record({
    action: 'organization.api_key.rotated',
    actorUserId: actor.userId ?? null,
    organizationId: actor.organizationId,
    resourceType: 'api_key',
    resourceId: keyId,
    metadata: { replacementId: created.id, graceMs },
  });

  return { created, previousKeyId: keyId, previousRevokedAt: revokeAt };
}

/** Lists keys. Metadata only — no hash, and certainly no secret. */
export async function listApiKeys(
  deps: ApiKeyDependencies,
  actor: ActorContext,
): Promise<readonly Omit<ApiKeyRow, 'keyHash'>[]> {
  assertPermission(actor, 'organization.api_key:read');
  return await deps.apiKeys.listForOrganization(actor.organizationId);
}
