import { type Permission, permissionScope } from './permissions.js';

/**
 * Accessible-workspace-set resolution.
 *
 * The single most load-bearing computation in the tenancy model. It is what lets the RLS
 * predicate stay two-level (organization_id and workspace_id) while the hierarchy is
 * three-level: team membership is expanded HERE, once per request, and the database
 * receives a concrete set rather than re-deriving it through joins in every policy
 * (05-data-architecture.md §3, 06-identity-and-access.md §3).
 */

export interface WorkspaceSetInput {
  /** Workspaces the actor holds a workspace-scoped role on, directly. */
  readonly directWorkspaceIds: readonly string[];
  /** Teams the actor belongs to. */
  readonly teamIds: readonly string[];
  /** Workspaces owned by each team (workspaces.team_id). */
  readonly workspacesOwnedByTeam: ReadonlyMap<string, readonly string[]>;
  /** Workspaces each team reaches through team_workspace_access, with expiry applied. */
  readonly workspacesGrantedToTeam: ReadonlyMap<string, readonly string[]>;
  /**
   * Every workspace in the organization. Used ONLY when the actor holds an
   * organization-scoped role that actually grants workspace-level access.
   */
  readonly allOrganizationWorkspaceIds: readonly string[];
  /**
   * Whether the actor holds an organization-scoped role that grants at least one
   * WORKSPACE-SCOPED permission.
   *
   * Not "holds any organization-scoped assignment" — that was a defect. `member` is an
   * organization-scoped role whose entire permission set is `organization.organization:read`;
   * treating it as organization-wide handed a plain member an accessible set containing every
   * workspace in the tenant, which is the value `app.workspace_ids` is built from and
   * therefore the predicate every workspace-scoped table is filtered by.
   *
   * Callers must compute this with `grantsOrganizationWideWorkspaceAccess`, never by
   * checking assignment shape.
   */
  readonly hasOrganizationScopedRole: boolean;
  /** An API key narrowed to one workspace cannot widen itself through team membership. */
  readonly restrictToWorkspaceId?: string;
}

export interface ResolvedWorkspaceSet {
  readonly workspaceIds: readonly string[];
  readonly teamIds: readonly string[];
  readonly workspacesByTeam: ReadonlyMap<string, readonly string[]>;
  /**
   * How far the database should let this actor see across the tenant's workspaces.
   *
   * 'all' only when organization-wide workspace access was genuinely earned AND no narrowing
   * (an API key bound to one workspace) applies. Everything else is 'set'.
   */
  readonly workspaceScope: 'set' | 'all';
}

/**
 * Whether a set of organization-scoped assignments grants workspace-level access.
 *
 * An assignment at organization scope spans the tenant only if the role it carries actually
 * reaches into workspaces. A role that can read the organization record and nothing else
 * reaches no workspace at all, and must resolve to an empty set.
 */
export function grantsOrganizationWideWorkspaceAccess(
  assignments: readonly {
    readonly teamId?: string;
    readonly workspaceId?: string;
    readonly permissions: readonly Permission[];
  }[],
): boolean {
  return assignments.some(
    (a) =>
      a.teamId === undefined &&
      a.workspaceId === undefined &&
      a.permissions.some((p) => permissionScope(p) === 'workspace'),
  );
}

/**
 * Resolves the set, deterministically.
 *
 * Sorted output, because this value is cached per (session, organization) and an unstable
 * order would make two identical sets look like a change — invalidating the cache
 * constantly and, worse, making a diff of the value unreadable during an incident.
 */
export function resolveAccessibleWorkspaces(input: WorkspaceSetInput): ResolvedWorkspaceSet {
  const byTeam = new Map<string, readonly string[]>();
  const accessible = new Set<string>();

  // An organization-scoped role spans the tenant. Without this, an owner would see no
  // workspace at all until someone assigned them one individually — and the accessible set
  // would stop matching what the authorization layer says the actor may do.
  if (input.hasOrganizationScopedRole) {
    for (const id of input.allOrganizationWorkspaceIds) accessible.add(id);
  }

  for (const id of input.directWorkspaceIds) accessible.add(id);

  for (const teamId of input.teamIds) {
    const owned = input.workspacesOwnedByTeam.get(teamId) ?? [];
    const granted = input.workspacesGrantedToTeam.get(teamId) ?? [];
    const reachable = [...new Set([...owned, ...granted])].sort();
    byTeam.set(teamId, reachable);
    for (const id of reachable) accessible.add(id);
  }

  // A narrowed API key intersects rather than unions: the narrowing must not be widened by
  // whatever the underlying member happens to be able to reach.
  const restrict = input.restrictToWorkspaceId;
  const workspaceIds =
    restrict === undefined ? [...accessible].sort() : accessible.has(restrict) ? [restrict] : [];

  // Organization-wide scope survives only if nothing narrows it. A key bound to one
  // workspace must not inherit 'all' from the member who created it.
  const workspaceScope: 'set' | 'all' =
    input.hasOrganizationScopedRole && restrict === undefined ? 'all' : 'set';

  return {
    workspaceIds,
    teamIds: [...input.teamIds].sort(),
    workspacesByTeam: byTeam,
    workspaceScope,
  };
}

/** Formats the set as the PostgreSQL uuid[] literal handed to `SET LOCAL app.workspace_ids`. */
export function toPostgresArrayLiteral(workspaceIds: readonly string[]): string {
  return `{${workspaceIds.join(',')}}`;
}
