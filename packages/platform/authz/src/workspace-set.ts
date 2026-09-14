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
   * organization-scoped role, which by definition spans the whole tenant.
   */
  readonly allOrganizationWorkspaceIds: readonly string[];
  /** Whether the actor holds any organization-scoped role assignment. */
  readonly hasOrganizationScopedRole: boolean;
  /** An API key narrowed to one workspace cannot widen itself through team membership. */
  readonly restrictToWorkspaceId?: string;
}

export interface ResolvedWorkspaceSet {
  readonly workspaceIds: readonly string[];
  readonly teamIds: readonly string[];
  readonly workspacesByTeam: ReadonlyMap<string, readonly string[]>;
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

  return {
    workspaceIds,
    teamIds: [...input.teamIds].sort(),
    workspacesByTeam: byTeam,
  };
}

/** Formats the set as the PostgreSQL uuid[] literal handed to `SET LOCAL app.workspace_ids`. */
export function toPostgresArrayLiteral(workspaceIds: readonly string[]): string {
  return `{${workspaceIds.join(',')}}`;
}
