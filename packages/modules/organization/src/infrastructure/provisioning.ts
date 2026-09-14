/**
 * Organization provisioning — the two onboarding paths (14-roadmap.md Phase 1).
 *
 * An AGENCY gets the full hierarchy: teams are real, workspaces are clients, and staffing
 * happens through team membership. A DIRECT BUSINESS gets the same shape with a single
 * default team, so the team layer carries no information and the UI collapses it.
 *
 * They produce the same structure deliberately. A business that later becomes an agency —
 * which happens — must not need a data migration, and every query in the system can assume
 * a workspace has a team.
 *
 * These writes run through withoutTenantContext because they CREATE the tenant: there is no
 * organization to scope to until the first statement commits. The connection is still
 * growth_os_app and still NOBYPASSRLS, so the RLS policies apply — which is why each insert
 * below is preceded by setting the context once the organization id exists.
 */
import { randomUUID } from 'node:crypto';
import { ValidationError } from '@growth-os/errors';
import type { Pool, PoolClient } from 'pg';
import { systemRoleId } from './actor-resolver.js';

export type OrganizationKind = 'agency' | 'business';

export interface ProvisionInput {
  readonly name: string;
  readonly slug: string;
  readonly kind: OrganizationKind;
  /** The user who signs up. Becomes the owner. */
  readonly ownerUserId: string;
  readonly billingEmail?: string;
  readonly timezone?: string;
}

export interface ProvisionedOrganization {
  readonly organizationId: string;
  readonly defaultTeamId: string;
  readonly ownerMemberId: string;
  /** A direct business gets its own workspace immediately; an agency starts with none. */
  readonly initialWorkspaceId?: string;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;

/**
 * Creates an organization, its default team, the owner membership and the owner role
 * assignment — as one transaction.
 *
 * All of it or none of it: an organization with no owner is unreachable by anyone, and an
 * owner with no role assignment is locked out of the tenant they just created. Both are
 * states that can only be repaired with database access.
 */
export async function provisionOrganization(
  pool: Pool,
  input: ProvisionInput,
): Promise<ProvisionedOrganization> {
  if (!SLUG.test(input.slug)) {
    throw new ValidationError(
      'An organization slug must be lower-case letters, digits and hyphens, 3-50 characters.',
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const organizationId = randomUUID();
    await client.query('SELECT set_config($1, $2, true)', ['app.organization_id', organizationId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.user_id', input.ownerUserId]);

    await client.query(
      `INSERT INTO organizations (id, slug, name, kind, billing_email, default_timezone)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'UTC'))`,
      [
        organizationId,
        input.slug,
        input.name,
        input.kind,
        input.billingEmail ?? null,
        input.timezone ?? null,
      ],
    );

    // Every organization gets a default team, agency or not. See the file header.
    const defaultTeamId = randomUUID();
    await client.query(
      `INSERT INTO teams (id, organization_id, slug, name, is_default)
         VALUES ($1, $2, 'default', $3, true)`,
      [defaultTeamId, organizationId, input.kind === 'agency' ? 'Core team' : 'Everyone'],
    );

    const ownerMemberId = randomUUID();
    await client.query(
      `INSERT INTO organization_members
         (id, organization_id, user_id, status, member_type, joined_at)
         VALUES ($1, $2, $3, 'active', 'staff', now())`,
      [ownerMemberId, organizationId, input.ownerUserId],
    );

    await client.query(
      `INSERT INTO team_members (id, organization_id, team_id, organization_member_id, role)
         VALUES ($1, $2, $3, $4, 'team_lead')`,
      [randomUUID(), organizationId, defaultTeamId, ownerMemberId],
    );

    await client.query(
      `INSERT INTO role_assignments (id, organization_id, organization_member_id, role_id)
         VALUES ($1, $2, $3, $4)`,
      [randomUUID(), organizationId, ownerMemberId, systemRoleId('owner')],
    );

    // A direct business works in one workspace and should never be asked to create it.
    // An agency's workspaces are its clients, so it starts with none.
    let initialWorkspaceId: string | undefined;
    if (input.kind === 'business') {
      initialWorkspaceId = randomUUID();
      await client.query(
        `INSERT INTO workspaces (id, organization_id, team_id, slug, name, kind, timezone)
           VALUES ($1, $2, $3, 'main', $4, 'internal', COALESCE($5, 'UTC'))`,
        [initialWorkspaceId, organizationId, defaultTeamId, input.name, input.timezone ?? null],
      );
    }

    await client.query('COMMIT');
    return {
      organizationId,
      defaultTeamId,
      ownerMemberId,
      ...(initialWorkspaceId === undefined ? {} : { initialWorkspaceId }),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface CreateWorkspaceInput {
  readonly organizationId: string;
  readonly teamId: string;
  readonly slug: string;
  readonly name: string;
  readonly kind?: 'client' | 'internal' | 'brand';
  readonly clientReference?: string;
}

/** Creates a workspace owned by a team. For an agency, this is onboarding a client. */
export async function createWorkspace(
  client: PoolClient,
  input: CreateWorkspaceInput,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO workspaces (id, organization_id, team_id, slug, name, kind, client_reference)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'client'), $7)`,
    [
      id,
      input.organizationId,
      input.teamId,
      input.slug,
      input.name,
      input.kind ?? null,
      input.clientReference ?? null,
    ],
  );
  return id;
}

export interface AddMemberInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly memberType?: 'staff' | 'client';
}

export async function addMember(client: PoolClient, input: AddMemberInput): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO organization_members
       (id, organization_id, user_id, status, member_type, joined_at)
       VALUES ($1, $2, $3, 'active', COALESCE($4, 'staff'), now())`,
    [id, input.organizationId, input.userId, input.memberType ?? null],
  );
  return id;
}

export async function addTeamMember(
  client: PoolClient,
  organizationId: string,
  teamId: string,
  memberId: string,
  role: 'team_lead' | 'team_member' = 'team_member',
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO team_members (id, organization_id, team_id, organization_member_id, role)
       VALUES ($1, $2, $3, $4, $5)`,
    [id, organizationId, teamId, memberId, role],
  );
  return id;
}

export async function createTeam(
  client: PoolClient,
  organizationId: string,
  slug: string,
  name: string,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO teams (id, organization_id, slug, name) VALUES ($1, $2, $3, $4)`,
    [id, organizationId, slug, name],
  );
  return id;
}

export interface AssignRoleInput {
  readonly organizationId: string;
  readonly memberId: string;
  readonly roleSlug: string;
  readonly teamId?: string;
  readonly workspaceId?: string;
  readonly expiresAt?: Date;
}

/** Assigns a system role at exactly one of the three scopes. */
export async function assignRole(client: PoolClient, input: AssignRoleInput): Promise<string> {
  if (input.teamId !== undefined && input.workspaceId !== undefined) {
    throw new ValidationError('A role assignment has one scope: team or workspace, not both.');
  }
  const id = randomUUID();
  await client.query(
    `INSERT INTO role_assignments
       (id, organization_id, organization_member_id, role_id, team_id, workspace_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      input.organizationId,
      input.memberId,
      systemRoleId(input.roleSlug),
      input.teamId ?? null,
      input.workspaceId ?? null,
      input.expiresAt ?? null,
    ],
  );
  return id;
}

/** Grants a second team access to a workspace it does not own — the specialist-pod case. */
export async function grantTeamWorkspaceAccess(
  client: PoolClient,
  organizationId: string,
  teamId: string,
  workspaceId: string,
  accessLevel = 'contributor',
  expiresAt?: Date,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO team_workspace_access
       (id, organization_id, team_id, workspace_id, access_level, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, organizationId, teamId, workspaceId, accessLevel, expiresAt ?? null],
  );
  return id;
}
