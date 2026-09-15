/**
 * Resolves a database-backed ActorContext.
 *
 * This is the join between the two halves of the access model: it reads membership, roles,
 * teams and grants, hands the permission set to @growth-os/authz for the fine-grained
 * decision, and produces the accessible-workspace set that @growth-os/db writes into
 * app.workspace_ids for RLS to enforce (06-identity-and-access.md §3-§4).
 *
 * It runs BEFORE a tenant transaction opens, because the value it produces is what makes
 * that transaction tenant-scoped. It therefore reads through withoutTenantContext and its
 * queries are keyed by an already-authenticated user id — never by anything the caller
 * supplied about the tenant.
 */
import {
  type ActorContext,
  grantsOrganizationWideWorkspaceAccess,
  type Permission,
  type RoleAssignment,
  resolveAccessibleWorkspaces,
  SYSTEM_ROLES,
} from '@growth-os/authz';
import { withOrganizationScope } from '@growth-os/db';
import { NotFoundError } from '@growth-os/errors';
import type { Pool, PoolClient } from 'pg';

/** System role permission sets, by role id. */
const SYSTEM_ROLE_PERMISSIONS = new Map<string, readonly Permission[]>();

/** Role slugs by id, seeded from migration 0006. Fixed so an id means the same everywhere. */
const SYSTEM_ROLE_IDS: ReadonlyArray<readonly [string, string, string]> = [
  ['01900000-0000-7000-8000-000000000001', 'owner', 'organization'],
  ['01900000-0000-7000-8000-000000000002', 'admin', 'organization'],
  ['01900000-0000-7000-8000-000000000003', 'billing', 'organization'],
  ['01900000-0000-7000-8000-000000000004', 'analyst', 'organization'],
  ['01900000-0000-7000-8000-000000000005', 'member', 'organization'],
  ['01900000-0000-7000-8000-000000000006', 'team_lead', 'team'],
  ['01900000-0000-7000-8000-000000000007', 'team_member', 'team'],
  ['01900000-0000-7000-8000-000000000008', 'workspace_admin', 'workspace'],
  ['01900000-0000-7000-8000-000000000009', 'editor', 'workspace'],
  ['01900000-0000-7000-8000-000000000010', 'contributor', 'workspace'],
  ['01900000-0000-7000-8000-000000000011', 'approver', 'workspace'],
  ['01900000-0000-7000-8000-000000000012', 'viewer', 'workspace'],
  ['01900000-0000-7000-8000-000000000013', 'client_guest', 'workspace'],
];

for (const [id, slug, scope] of SYSTEM_ROLE_IDS) {
  const role = SYSTEM_ROLES.find((r) => r.slug === slug && r.scope === scope);
  if (role !== undefined) SYSTEM_ROLE_PERMISSIONS.set(id, role.permissions);
}

/** The id of a seeded system role, for provisioning and tests. */
export function systemRoleId(slug: string): string {
  const found = SYSTEM_ROLE_IDS.find((r) => r[1] === slug);
  if (found === undefined) throw new NotFoundError(`No system role '${slug}'.`);
  return found[0];
}

export { SYSTEM_ROLE_IDS };

interface AssignmentRow {
  role_id: string;
  team_id: string | null;
  workspace_id: string | null;
  expires_at: Date | null;
  is_system: boolean;
}

export interface ResolveActorInput {
  readonly userId: string;
  readonly organizationId: string;
  readonly mfaSatisfied: boolean;
  readonly impersonated?: boolean;
}

/**
 * Reads everything the authorization layer needs for one (user, organization) pair.
 *
 * Deliberately a handful of narrow queries rather than one join: the result is cached per
 * (session, organization) for 60s, so this runs once per cache miss, and a readable query
 * per concept is worth more here than saving three round trips on a cold path.
 */
export async function resolveActorContext(
  pool: Pool,
  input: ResolveActorInput,
): Promise<ActorContext | undefined> {
  // Scoped to the requested organization, with an empty workspace set. See
  // withOrganizationScope for why that is not a bypass: it narrows what can be read, and
  // the membership query below is what actually authorises.
  return await withOrganizationScope(
    pool,
    input.organizationId,
    // 'all' because resolution must see the whole team→workspace topology in order to
    // compute the set; it reads ids and team ids and returns a computed set, never rows.
    { reason: 'actor context resolution', workspaceScope: 'all' },
    async (client) => {
      const member = await client.query<{
        id: string;
        status: string;
        member_type: string;
        org_status: string;
        mfa_required: boolean;
      }>(
        `SELECT m.id, m.status, m.member_type, o.status AS org_status, o.mfa_required
           FROM organization_members m
           JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = $1 AND m.organization_id = $2`,
        [input.userId, input.organizationId],
      );

      const row = member.rows[0];
      // No membership row, or a removed one, is not an error the caller may distinguish from
      // a non-existent organization — that difference leaks which organizations exist.
      if (row === undefined || row.status !== 'active') return undefined;

      const assignments = await loadAssignments(client, row.id, input.organizationId);
      const teamIds = await loadTeamIds(client, row.id);
      const owned = await loadWorkspacesOwnedByTeam(client, input.organizationId);
      const granted = await loadWorkspacesGrantedToTeam(client, input.organizationId);
      const allWorkspaces = await loadAllWorkspaceIds(client, input.organizationId);

      const resolved = resolveAccessibleWorkspaces({
        directWorkspaceIds: assignments
          .map((a) => a.workspaceId)
          .filter((id): id is string => id !== undefined),
        teamIds,
        workspacesOwnedByTeam: owned,
        workspacesGrantedToTeam: granted,
        allOrganizationWorkspaceIds: allWorkspaces,
        // NOT "holds any organization-scoped assignment". `member` is organization-scoped and
        // grants only organization.organization:read; treating that as tenant-wide gave a
        // plain member every workspace in the organization. See the helper's doc comment.
        hasOrganizationScopedRole: grantsOrganizationWideWorkspaceAccess(assignments),
      });

      const grants = await loadResourceGrants(client, input.organizationId, row.id, teamIds);

      return {
        kind: 'user',
        userId: input.userId,
        organizationId: input.organizationId,
        organizationMemberId: row.id,
        organizationStatus: row.org_status as ActorContext['organizationStatus'],
        assignments,
        resourceGrants: grants,
        accessibleWorkspaceIds: resolved.workspaceIds,
        workspaceScope: resolved.workspaceScope,
        teamIds: resolved.teamIds,
        workspacesByTeam: resolved.workspacesByTeam,
        mfaSatisfied: input.mfaSatisfied,
        mfaRequired: row.mfa_required,
        impersonated: input.impersonated ?? false,
        apiKeyScopes: [],
      } satisfies ActorContext;
    },
  );
}

async function loadAssignments(
  client: PoolClient,
  memberId: string,
  organizationId: string,
): Promise<RoleAssignment[]> {
  const result = await client.query<AssignmentRow>(
    `SELECT ra.role_id, ra.team_id, ra.workspace_id, ra.expires_at, r.is_system
       FROM role_assignments ra
       JOIN roles r ON r.id = ra.role_id
      WHERE ra.organization_member_id = $1
        AND ra.organization_id = $2
        AND (ra.expires_at IS NULL OR ra.expires_at > now())`,
    [memberId, organizationId],
  );

  const assignments: RoleAssignment[] = [];
  for (const row of result.rows) {
    const permissions = row.is_system
      ? (SYSTEM_ROLE_PERMISSIONS.get(row.role_id) ?? [])
      : await loadCustomRolePermissions(client, row.role_id);
    assignments.push({
      roleId: row.role_id,
      permissions,
      ...(row.team_id === null ? {} : { teamId: row.team_id }),
      ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    });
  }
  return assignments;
}

async function loadCustomRolePermissions(
  client: PoolClient,
  roleId: string,
): Promise<readonly Permission[]> {
  const result = await client.query<{ permission: string }>(
    'SELECT permission FROM role_permissions WHERE role_id = $1',
    [roleId],
  );
  return result.rows.map((r) => r.permission as Permission);
}

async function loadTeamIds(client: PoolClient, memberId: string): Promise<string[]> {
  const result = await client.query<{ team_id: string }>(
    'SELECT team_id FROM team_members WHERE organization_member_id = $1',
    [memberId],
  );
  return result.rows.map((r) => r.team_id);
}

async function loadWorkspacesOwnedByTeam(
  client: PoolClient,
  organizationId: string,
): Promise<Map<string, readonly string[]>> {
  const result = await client.query<{ team_id: string; id: string }>(
    `SELECT team_id, id FROM workspaces
      WHERE organization_id = $1 AND team_id IS NOT NULL AND deleted_at IS NULL`,
    [organizationId],
  );
  return groupBy(
    result.rows,
    (r) => r.team_id,
    (r) => r.id,
  );
}

async function loadWorkspacesGrantedToTeam(
  client: PoolClient,
  organizationId: string,
): Promise<Map<string, readonly string[]>> {
  // Expiry applied here rather than in the resolver: a time-boxed client grant must stop
  // contributing the moment it lapses, without anyone remembering to remove the row.
  const result = await client.query<{ team_id: string; workspace_id: string }>(
    `SELECT team_id, workspace_id FROM team_workspace_access
      WHERE organization_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
    [organizationId],
  );
  return groupBy(
    result.rows,
    (r) => r.team_id,
    (r) => r.workspace_id,
  );
}

async function loadAllWorkspaceIds(client: PoolClient, organizationId: string): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    'SELECT id FROM workspaces WHERE organization_id = $1 AND deleted_at IS NULL',
    [organizationId],
  );
  return result.rows.map((r) => r.id);
}

async function loadResourceGrants(
  client: PoolClient,
  organizationId: string,
  memberId: string,
  teamIds: readonly string[],
): Promise<ActorContext['resourceGrants']> {
  const result = await client.query<{
    resource_type: string;
    resource_id: string;
    permission: string;
    expires_at: Date | null;
  }>(
    `SELECT resource_type, resource_id, permission, expires_at
       FROM resource_grants
      WHERE organization_id = $1
        AND (expires_at IS NULL OR expires_at > now())
        AND ((subject_type = 'member' AND subject_id = $2)
          OR (subject_type = 'team'   AND subject_id = ANY($3::uuid[])))`,
    [organizationId, memberId, teamIds],
  );
  return result.rows.map((r) => ({
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    permission: r.permission as Permission,
    ...(r.expires_at === null ? {} : { expiresAt: r.expires_at }),
  }));
}

function groupBy<T>(
  rows: readonly T[],
  key: (row: T) => string,
  value: (row: T) => string,
): Map<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const k = key(row);
    const existing = map.get(k);
    if (existing === undefined) map.set(k, [value(row)]);
    else existing.push(value(row));
  }
  return map;
}
