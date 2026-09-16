/**
 * Invitations, and the membership admission that accepting one performs.
 *
 * These are TENANT-SCOPED tables, so every query runs under RLS. The organization predicate
 * is therefore enforced twice: once by the `organization_id = $1` in the SQL, and once by
 * the policy. The redundancy is the point — a query that forgets its filter returns nothing
 * rather than another tenant's rows.
 */

import { randomUUID } from 'node:crypto';
import type { Permission } from '@growth-os/authz';
import type {
  AdmitInput,
  InvitationRepository,
  InvitationRow,
  MembershipWriter,
  OrganizationReader,
  RoleReader,
  RoleRecord,
  WorkspaceTopologyReader,
} from '../application/ports.js';
import { SYSTEM_ROLE_IDS } from './actor-resolver.js';

/** The subset of `pg` these repositories need; a Pool or PoolClient both satisfy it. */
export interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

interface InviteRow {
  id: string;
  organization_id: string;
  email: string;
  role_id: string;
  team_id: string | null;
  workspace_id: string | null;
  member_type: string;
  invited_by: string | null;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  token_hash: Buffer;
}

const INVITE_COLUMNS =
  'id, organization_id, email, role_id, team_id, workspace_id, member_type, invited_by, ' +
  'expires_at, accepted_at, revoked_at, token_hash';

function toInvitation(row: InviteRow): InvitationRow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    roleId: row.role_id,
    teamId: row.team_id,
    workspaceId: row.workspace_id,
    memberType: row.member_type as 'staff' | 'client',
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    tokenHash: row.token_hash,
  };
}

export function createInvitationRepository(db: Queryable): InvitationRepository {
  return {
    async create(input) {
      await db.query(
        `INSERT INTO invitations
           (id, organization_id, email, role_id, team_id, workspace_id, member_type,
            token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          input.id,
          input.organizationId,
          input.email,
          input.roleId,
          input.teamId ?? null,
          input.workspaceId ?? null,
          input.memberType,
          input.tokenHash,
          input.invitedBy,
          input.expiresAt,
        ],
      );
    },

    /**
     * Looks an invitation up by token hash.
     *
     * No `organization_id = $1` of its own, and it needs none: this runs inside the scope
     * opened from the organization the TOKEN names, so the RLS policy supplies the
     * predicate. A token pointed at another tenant finds nothing here — which is why
     * "accepting an invitation for the wrong organization" is a structural impossibility
     * rather than a check (ADR-0018).
     */
    async findByTokenHash(tokenHash) {
      const r = await db.query<InviteRow>(
        `SELECT ${INVITE_COLUMNS} FROM invitations WHERE token_hash = $1`,
        [tokenHash],
      );
      const row = r.rows[0];
      return row === undefined ? undefined : toInvitation(row);
    },

    async findById(organizationId, id) {
      // Scoped, so an id belonging to another tenant simply finds nothing.
      const r = await db.query<InviteRow>(
        `SELECT ${INVITE_COLUMNS} FROM invitations WHERE organization_id = $1 AND id = $2`,
        [organizationId, id],
      );
      const row = r.rows[0];
      return row === undefined ? undefined : toInvitation(row);
    },

    async findPending(organizationId, email) {
      const r = await db.query<InviteRow>(
        `SELECT ${INVITE_COLUMNS} FROM invitations
          WHERE organization_id = $1 AND email = $2
            AND accepted_at IS NULL AND revoked_at IS NULL`,
        [organizationId, email],
      );
      const row = r.rows[0];
      return row === undefined ? undefined : toInvitation(row);
    },

    /**
     * Single-use, settled by the DATABASE.
     *
     * Two concurrent redemptions of one token both pass a read-then-write check; only one
     * can match this UPDATE. The loser creates no membership.
     */
    async consume(id, at) {
      const r = await db.query(
        `UPDATE invitations SET accepted_at = $2, updated_at = now()
          WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [id, at],
      );
      return (r.rowCount ?? 0) === 1;
    },

    async revoke(organizationId, id, at) {
      const r = await db.query(
        `UPDATE invitations SET revoked_at = $3, updated_at = now()
          WHERE organization_id = $1 AND id = $2
            AND revoked_at IS NULL AND accepted_at IS NULL`,
        [organizationId, id, at],
      );
      return (r.rowCount ?? 0) === 1;
    },

    /**
     * Replaces the token, so a resend leaves exactly one live link rather than several.
     *
     * A COMPARE-AND-SET, not a blind write, and for the same reason `consume` is one. The
     * caller read the row to decide the invitation was still pending, and three things can
     * happen between that read and this write:
     *
     *   - another resend rotates the token first. Both writers would otherwise succeed and
     *     both would mail a link, one of which is already dead;
     *   - the invitation is ACCEPTED. A blind write would mint a fresh token for a consumed
     *     invitation and mail a link that can never work;
     *   - the invitation is REVOKED. A blind write would give a revoked invitation a live
     *     token hash and a fresh expiry — a revocation that did not fully take.
     *
     * Predicating on the previous hash makes the first impossible; the NULL checks make the
     * other two. The loser is told, and mails nothing.
     */
    async rotateToken(id, previousTokenHash, tokenHash, expiresAt, at) {
      const r = await db.query(
        `UPDATE invitations SET token_hash = $3, expires_at = $4, updated_at = $5
          WHERE id = $1 AND token_hash = $2
            AND accepted_at IS NULL AND revoked_at IS NULL`,
        [id, previousTokenHash, tokenHash, expiresAt, at],
      );
      return (r.rowCount ?? 0) === 1;
    },

    async listPending(organizationId) {
      const r = await db.query<InviteRow>(
        `SELECT ${INVITE_COLUMNS} FROM invitations
          WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
          ORDER BY created_at DESC`,
        [organizationId],
      );
      return r.rows.map(toInvitation);
    },
  };
}

const SYSTEM_ROLE_BY_ID = new Map(
  SYSTEM_ROLE_IDS.map(([id, slug, scope]) => [id, { slug, scope }]),
);

export function createRoleReader(db: Queryable): RoleReader {
  async function permissionsFor(roleId: string, isSystem: boolean): Promise<Permission[]> {
    if (isSystem) {
      const { SYSTEM_ROLES } = await import('@growth-os/authz');
      const meta = SYSTEM_ROLE_BY_ID.get(roleId);
      const role = SYSTEM_ROLES.find((r) => r.slug === meta?.slug && r.scope === meta?.scope);
      return [...(role?.permissions ?? [])];
    }
    const r = await db.query<{ permission: string }>(
      'SELECT permission FROM role_permissions WHERE role_id = $1',
      [roleId],
    );
    return r.rows.map((row) => row.permission as Permission);
  }

  return {
    async findAssignableRole(organizationId, slug) {
      // A system role, or a custom role belonging to THIS organization. The
      // `organization_id IS NULL OR = $1` mirrors the RLS policy exactly, so another
      // tenant's custom role is unreachable by both.
      const r = await db.query<{ id: string; slug: string; scope: string; is_system: boolean }>(
        `SELECT id, slug, scope, is_system FROM roles
          WHERE slug = $2 AND (organization_id IS NULL OR organization_id = $1)
          ORDER BY organization_id NULLS LAST LIMIT 1`,
        [organizationId, slug],
      );
      const row = r.rows[0];
      if (row === undefined) return undefined;
      return {
        id: row.id,
        slug: row.slug,
        scope: row.scope,
        permissions: await permissionsFor(row.id, row.is_system),
      } satisfies RoleRecord;
    },

    async findById(roleId) {
      const r = await db.query<{ id: string; slug: string; scope: string; is_system: boolean }>(
        'SELECT id, slug, scope, is_system FROM roles WHERE id = $1',
        [roleId],
      );
      const row = r.rows[0];
      if (row === undefined) return undefined;
      return {
        id: row.id,
        slug: row.slug,
        scope: row.scope,
        permissions: await permissionsFor(row.id, row.is_system),
      } satisfies RoleRecord;
    },
  };
}

export function createMembershipWriter(db: Queryable): MembershipWriter {
  return {
    async isMember(organizationId, userId) {
      const r = await db.query(
        `SELECT 1 FROM organization_members
          WHERE organization_id = $1 AND user_id = $2 AND status <> 'removed'`,
        [organizationId, userId],
      );
      return (r.rowCount ?? 0) > 0;
    },

    /**
     * Membership and role assignment together.
     *
     * The caller runs this inside a transaction, so a failure between the two statements
     * leaves neither — a member with no assignment has joined an organization they cannot
     * see, and repairing that needs database access.
     */
    async admit(input: AdmitInput) {
      const memberId = randomUUID();
      await db.query(
        `INSERT INTO organization_members
           (id, organization_id, user_id, status, member_type, invited_by, joined_at)
         VALUES ($1, $2, $3, 'active', $4, $5, $6)`,
        [memberId, input.organizationId, input.userId, input.memberType, input.invitedBy, input.at],
      );
      await db.query(
        `INSERT INTO role_assignments
           (id, organization_id, organization_member_id, role_id, team_id, workspace_id, granted_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          input.organizationId,
          memberId,
          input.roleId,
          input.teamId,
          input.workspaceId,
          input.invitedBy,
        ],
      );
      return memberId;
    },
  };
}

export function createOrganizationReader(db: Queryable): OrganizationReader {
  return {
    async nameOf(organizationId) {
      // Tenant-scoped like everything else: `organizations` is filtered on `id`, so this
      // returns nothing outside the open scope.
      const r = await db.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [
        organizationId,
      ]);
      return r.rows[0]?.name;
    },
  };
}

export function createWorkspaceTopologyReader(db: Queryable): WorkspaceTopologyReader {
  return {
    async allWorkspaceIds(organizationId) {
      const r = await db.query<{ id: string }>(
        'SELECT id FROM workspaces WHERE organization_id = $1 AND deleted_at IS NULL',
        [organizationId],
      );
      return r.rows.map((row) => row.id);
    },
  };
}
