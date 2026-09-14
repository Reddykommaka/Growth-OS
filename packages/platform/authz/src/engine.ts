/**
 * The policy engine.
 *
 * Implements the evaluation order in 06-identity-and-access.md §3 exactly, in order, with
 * default deny at the end. Every branch returns a REASON as well as a decision: a
 * permission failure that says only "forbidden" is unactionable in an incident, and a
 * support engineer guessing at why access was denied is how a temporary over-grant happens.
 *
 * The interface is deliberately narrow (`decide` / `assert`) so the evaluator can later be
 * swapped for OpenFGA without touching a call site (06 §3, ReBAC migration path).
 */
import { ForbiddenError } from '@growth-os/errors';
import type { ActorContext, RoleAssignment } from './actor.js';
import type { Permission } from './permissions.js';

export interface ResourceRef {
  readonly type: string;
  readonly id: string;
  /** The workspace owning the resource. Omitted for organization- and team-level resources. */
  readonly workspaceId?: string;
  /**
   * The team the resource IS, or belongs to. Set for team-scoped resources (a team, its
   * membership), so a team-scoped role can authorise an action on its own team — which has
   * no workspace to match against.
   */
  readonly teamId?: string;
  /** Set when the actor owns the resource, for ownership rules such as a deal you own. */
  readonly ownedByActor?: boolean;
}

export type DenyReason =
  | 'organization_suspended'
  | 'mfa_required'
  | 'not_a_member'
  | 'workspace_not_accessible'
  | 'impersonation_denied'
  | 'api_key_scope'
  | 'no_grant';

export type AuthzDecision =
  | { readonly allowed: true; readonly via: GrantSource }
  | { readonly allowed: false; readonly reason: DenyReason };

export type GrantSource =
  | 'organization_scope'
  | 'team_scope'
  | 'workspace_scope'
  | 'resource_grant'
  | 'ownership';

export interface DecideOptions {
  /** Now, injected rather than read from the clock, so expiry is testable. */
  readonly now?: Date;
}

/**
 * Permissions denied to an impersonating support session, unconditionally.
 *
 * Support access is a constrained feature, not a master key (06 §2): impersonation may not
 * read credentials or move money, regardless of what the impersonated user could do.
 */
const IMPERSONATION_DENIED: ReadonlySet<string> = new Set<Permission>([
  'integrations.credential:read',
  'organization.api_key:read',
  'organization.api_key:create',
  'organization.api_key:revoke',
  'billing.subscription:manage',
  'billing.payment_method:manage',
  'marketplace.payout:read',
]);

function active(assignment: { readonly expiresAt?: Date }, now: Date): boolean {
  return assignment.expiresAt === undefined || assignment.expiresAt > now;
}

function grants(assignment: RoleAssignment, permission: Permission): boolean {
  return assignment.permissions.includes(permission);
}

/**
 * A suspended, closing or closed organization is read-only.
 *
 * Not fully dark: the owner must still see the organization, read the notification
 * explaining why, and reach billing to resolve it. Locking them out of billing would make a
 * suspension for non-payment unfixable from inside the product.
 */
function readableWhileSuspended(permission: Permission): boolean {
  return (
    permission === 'organization.organization:read' ||
    permission.startsWith('billing.') ||
    permission === 'notifications.notification:read'
  );
}

/** Scope checks for a machine actor. Returns a reason to deny, or undefined to continue. */
function denyApiKey(
  actor: ActorContext,
  permission: Permission,
  resource?: ResourceRef,
): DenyReason | undefined {
  const module = permission.slice(0, permission.indexOf('.'));
  // A key carries explicit scopes; holding the underlying permission is not enough.
  if (!actor.apiKeyScopes.includes(permission) && !actor.apiKeyScopes.includes(module)) {
    return 'api_key_scope';
  }
  if (
    actor.apiKeyWorkspaceId !== undefined &&
    resource?.workspaceId !== undefined &&
    resource.workspaceId !== actor.apiKeyWorkspaceId
  ) {
    return 'workspace_not_accessible';
  }
  return undefined;
}

/**
 * The denial half of the evaluation order (06-identity-and-access.md §3).
 *
 * Every check here is independently sufficient to deny, and all of them run before any
 * grant is considered. Kept separate from the allowances so a reviewer can read the
 * complete list of ways access is refused without tracing through the ways it is permitted
 * — which is the review this function most needs to support.
 */
function denialReason(
  actor: ActorContext,
  permission: Permission,
  resource?: ResourceRef,
): DenyReason | undefined {
  if (actor.organizationStatus !== 'active' && !readableWhileSuspended(permission)) {
    return 'organization_suspended';
  }

  if (actor.mfaRequired && !actor.mfaSatisfied) return 'mfa_required';

  // An actor with no membership row is not a tenant, whatever roles they appear to carry.
  if (actor.kind === 'user' && actor.organizationMemberId === undefined) return 'not_a_member';

  if (actor.impersonated && IMPERSONATION_DENIED.has(permission)) return 'impersonation_denied';

  if (actor.kind === 'api_key') {
    const reason = denyApiKey(actor, permission, resource);
    if (reason !== undefined) return reason;
  }

  // A workspace-scoped resource outside the accessible set is denied before any role is
  // consulted — the same boundary RLS enforces, asserted here so the failure is a clear
  // permission error rather than an empty result set.
  if (
    resource?.workspaceId !== undefined &&
    !actor.accessibleWorkspaceIds.includes(resource.workspaceId)
  ) {
    return 'workspace_not_accessible';
  }

  return undefined;
}

/** Whether one assignment authorises this permission on this resource, and at which scope. */
function assignmentGrants(
  actor: ActorContext,
  assignment: RoleAssignment,
  resource?: ResourceRef,
): GrantSource | undefined {
  // Organization scope: neither teamId nor workspaceId set.
  if (assignment.teamId === undefined && assignment.workspaceId === undefined) {
    return 'organization_scope';
  }

  // Team scope: either the resource IS this team, or its workspace is owned by or granted
  // to this team.
  if (assignment.teamId !== undefined) {
    if (resource?.teamId !== undefined && resource.teamId === assignment.teamId) {
      return 'team_scope';
    }
    if (resource?.workspaceId === undefined) return undefined;
    const reachable = actor.workspacesByTeam.get(assignment.teamId) ?? [];
    return reachable.includes(resource.workspaceId) ? 'team_scope' : undefined;
  }

  // Workspace scope: this workspace only.
  return assignment.workspaceId === resource?.workspaceId ? 'workspace_scope' : undefined;
}

/** Resource-level grants and ownership — the two routes to access that are not roles. */
function resourceLevelGrant(
  actor: ActorContext,
  permission: Permission,
  resource: ResourceRef,
  now: Date,
): GrantSource | undefined {
  for (const grant of actor.resourceGrants) {
    if (
      active(grant, now) &&
      grant.permission === permission &&
      grant.resourceType === resource.type &&
      grant.resourceId === resource.id
    ) {
      return 'resource_grant';
    }
  }

  // Ownership rules, e.g. updating a deal you own. Never applies to a sensitive permission:
  // owning a connection must not mean reading its credentials.
  if (resource.ownedByActor !== true || IMPERSONATION_DENIED.has(permission)) return undefined;
  const holds = actor.assignments.some((a) => active(a, now) && grants(a, permission));
  return holds ? 'ownership' : undefined;
}

/**
 * Decides whether an actor may perform a permission, optionally on a specific resource.
 *
 * Returns a decision rather than throwing, so a caller that needs to branch (hiding a menu
 * item) uses the same logic as one that needs to deny. The UI hiding what an actor cannot
 * do is usability; `assertPermission` is the security boundary.
 *
 * Denials first, then allowances, then default deny — the order in 06 §3, kept literal.
 */
export function decide(
  actor: ActorContext,
  permission: Permission,
  resource?: ResourceRef,
  options: DecideOptions = {},
): AuthzDecision {
  const now = options.now ?? new Date();

  const denied = denialReason(actor, permission, resource);
  if (denied !== undefined) return { allowed: false, reason: denied };

  for (const assignment of actor.assignments) {
    if (!active(assignment, now) || !grants(assignment, permission)) continue;
    const via = assignmentGrants(actor, assignment, resource);
    if (via !== undefined) return { allowed: true, via };
  }

  if (resource !== undefined) {
    const via = resourceLevelGrant(actor, permission, resource, now);
    if (via !== undefined) return { allowed: true, via };
  }

  return { allowed: false, reason: 'no_grant' };
}

/** Why a specific denial happened. Server-side only — see assertPermission. */
export interface DenialDetail {
  readonly permission: Permission;
  readonly reason: DenyReason;
  readonly resourceType?: string;
}

/**
 * Asserts a permission, throwing `ForbiddenError` when denied.
 *
 * The reason travels on the error's `cause`, NOT in its `meta`. `toProblemDetails`
 * serialises `meta` into the 4xx response body, and "denied: no_grant on crm.deal:update"
 * would hand a caller a map of the tenant's role model one probe at a time. `cause` is
 * never serialised, so the detail reaches the logs and the trace and stops there.
 *
 * A caller that needs to branch on the reason should call `decide` and read it directly,
 * rather than catching this and unwrapping the cause.
 */
export function assertPermission(
  actor: ActorContext,
  permission: Permission,
  resource?: ResourceRef,
  options: DecideOptions = {},
): void {
  const decision = decide(actor, permission, resource, options);
  if (decision.allowed) return;
  const detail: DenialDetail = {
    permission,
    reason: decision.reason,
    ...(resource === undefined ? {} : { resourceType: resource.type }),
  };
  throw new ForbiddenError('You do not have permission to perform this action.', {
    cause: detail,
  });
}
