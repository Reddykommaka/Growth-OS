/**
 * The resolved actor context.
 *
 * Built once per request by the composition root, before any transaction opens. The unit of
 * work refuses to open a tenant-scoped transaction without one (06-identity-and-access.md
 * §4), which is what stops application code from choosing its own tenant context.
 */
import type { Permission } from './permissions.js';

export type ActorKind = 'user' | 'api_key' | 'system';

/** A role assignment as stored, at exactly one of the three scopes. */
export interface RoleAssignment {
  readonly roleId: string;
  readonly permissions: readonly Permission[];
  /** Set for a team-scoped assignment. */
  readonly teamId?: string;
  /** Set for a workspace-scoped assignment. */
  readonly workspaceId?: string;
  readonly expiresAt?: Date;
}

/** A grant on one specific resource, for the sharing case pure RBAC handles badly. */
export interface ResourceGrant {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly permission: Permission;
  readonly expiresAt?: Date;
}

export interface ActorContext {
  readonly kind: ActorKind;
  readonly userId?: string;
  readonly apiKeyId?: string;
  readonly organizationId: string;
  readonly organizationMemberId?: string;
  /** Organization status. A suspended organization denies everything but reading itself. */
  readonly organizationStatus: 'active' | 'suspended' | 'closing' | 'closed';
  readonly assignments: readonly RoleAssignment[];
  readonly resourceGrants: readonly ResourceGrant[];
  /**
   * The resolved accessible-workspace set — the exact value handed to the database as
   * app.workspace_ids. Computed by resolveAccessibleWorkspaces, never by a call site.
   */
  readonly accessibleWorkspaceIds: readonly string[];
  /**
   * How far this actor may see across the tenant's workspaces, handed to the database as
   * app.workspace_scope. 'all' only for an actor with genuine organization-wide workspace
   * access; every other actor is bound to `accessibleWorkspaceIds`.
   */
  readonly workspaceScope: 'set' | 'all';
  /** Teams the actor belongs to, used to match team-scoped assignments to workspaces. */
  readonly teamIds: readonly string[];
  /** Workspaces each of the actor's teams can reach, including team_workspace_access. */
  readonly workspacesByTeam: ReadonlyMap<string, readonly string[]>;
  readonly mfaSatisfied: boolean;
  readonly mfaRequired: boolean;
  /** Set when this session is a support impersonation. */
  readonly impersonated: boolean;
  /** Scopes carried by an API key. Empty for a user session. */
  readonly apiKeyScopes: readonly string[];
  /** A key narrowed to one workspace cannot act outside it. */
  readonly apiKeyWorkspaceId?: string;
}
