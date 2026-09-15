/** Sessions: creation, lookup by token hash, renewal and revocation. */
import type {
  CreateSessionInput,
  SessionRecordRow,
  SessionRepository,
} from '../application/ports.js';
import type { Queryable } from './queryable.js';

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  mfa_satisfied_at: Date | null;
  impersonator_user_id: string | null;
  impersonation_expires_at: Date | null;
  active_organization_id: string | null;
  device_label: string | null;
  ip: string | null;
  user_agent: string | null;
  last_used_at: Date;
  created_at: Date;
}

/** Deliberately excludes token_hash: it never leaves the database. */
const SESSION_COLUMNS =
  'id, user_id, expires_at, absolute_expires_at, revoked_at, mfa_satisfied_at, ' +
  'impersonator_user_id, impersonation_expires_at, active_organization_id, device_label, ' +
  // host(), not ip::text. Casting inet to text appends the netmask — '10.0.0.1' comes back
  // as '10.0.0.1/32', which is wrong in a device list and would be compared against a bare
  // address elsewhere. Measured, not assumed. host() is correct for IPv6 too.
  'host(ip) AS ip, user_agent, last_used_at, created_at';

function toSession(row: SessionRow): SessionRecordRow {
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    revokedAt: row.revoked_at,
    mfaSatisfiedAt: row.mfa_satisfied_at,
    impersonatorUserId: row.impersonator_user_id,
    impersonationExpiresAt: row.impersonation_expires_at,
    activeOrganizationId: row.active_organization_id,
    deviceLabel: row.device_label,
    ip: row.ip,
    userAgent: row.user_agent,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

export function createSessionRepository(db: Queryable): SessionRepository {
  return {
    async create(input: CreateSessionInput) {
      const r = await db.query<SessionRow>(
        `INSERT INTO sessions
           (id, user_id, token_hash, expires_at, absolute_expires_at, mfa_satisfied_at,
            ip, user_agent, device_label, impersonator_user_id, impersonation_reason,
            impersonation_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8, $9, $10, $11, $12)
         RETURNING ${SESSION_COLUMNS}`,
        [
          input.id,
          input.userId,
          input.tokenHash,
          input.expiresAt,
          input.absoluteExpiresAt,
          input.mfaSatisfiedAt,
          input.ip ?? null,
          input.userAgent ?? null,
          input.deviceLabel ?? null,
          input.impersonatorUserId ?? null,
          input.impersonationReason ?? null,
          input.impersonationExpiresAt ?? null,
        ],
      );
      const row = r.rows[0];
      if (row === undefined) throw new Error('Inserting the session returned no row.');
      return toSession(row);
    },

    async findByTokenHash(tokenHash) {
      const r = await db.query<SessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE token_hash = $1`,
        [tokenHash],
      );
      const row = r.rows[0];
      return row === undefined ? undefined : toSession(row);
    },

    async touch(sessionId, at, expiresAt) {
      await db.query(
        `UPDATE sessions
            SET last_used_at = $2,
                expires_at = COALESCE($3, expires_at),
                updated_at = now()
          WHERE id = $1`,
        [sessionId, at, expiresAt ?? null],
      );
    },

    async revoke(sessionId, at, reason) {
      // COALESCE keeps the FIRST revocation time. Overwriting it would rewrite history for
      // an incident investigation.
      await db.query(
        `UPDATE sessions
            SET revoked_at = COALESCE(revoked_at, $2), revoked_reason = COALESCE(revoked_reason, $3),
                updated_at = now()
          WHERE id = $1`,
        [sessionId, at, reason],
      );
    },

    async revokeAllForUser(userId, at, reason, exceptSessionId) {
      const r = await db.query(
        `UPDATE sessions
            SET revoked_at = $2, revoked_reason = $3, updated_at = now()
          WHERE user_id = $1
            AND revoked_at IS NULL
            AND ($4::uuid IS NULL OR id <> $4::uuid)`,
        [userId, at, reason, exceptSessionId ?? null],
      );
      return r.rowCount ?? 0;
    },

    async listForUser(userId) {
      const r = await db.query<SessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM sessions
          WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY last_used_at DESC`,
        [userId],
      );
      return r.rows.map(toSession);
    },

    async recordMfaSatisfied(sessionId, at) {
      await db.query(
        'UPDATE sessions SET mfa_satisfied_at = $2, updated_at = now() WHERE id = $1',
        [sessionId, at],
      );
    },

    async setActiveOrganization(sessionId, organizationId) {
      await db.query(
        'UPDATE sessions SET active_organization_id = $2, updated_at = now() WHERE id = $1',
        [sessionId, organizationId],
      );
    },
  };
}
