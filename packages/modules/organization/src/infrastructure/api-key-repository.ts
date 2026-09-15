/**
 * API keys.
 *
 * Tenant-scoped, so every query runs under RLS — an api_keys row belonging to another
 * organization is unreachable even with its id.
 *
 * `findByPrefix` carries no `organization_id = $1` of its own, and does not need one: it
 * runs inside the scope opened from the organization the key's prefix names, so the policy
 * supplies the predicate. A prefix pointed at another tenant finds nothing (ADR-0018).
 */
import type { Permission } from '@growth-os/authz';
import type { ApiKeyRepository, ApiKeyRow } from '../application/ports.js';
import type { Queryable } from './invitation-repository.js';

interface KeyRow {
  id: string;
  organization_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: string[];
  workspace_id: string | null;
  created_by: string | null;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

const KEY_COLUMNS =
  'id, organization_id, name, prefix, key_hash, scopes, workspace_id, created_by, ' +
  'last_used_at, expires_at, revoked_at';

/** Excludes key_hash. A listing must never carry the material an attacker would grind. */
const PUBLIC_COLUMNS =
  'id, organization_id, name, prefix, scopes, workspace_id, created_by, ' +
  'last_used_at, expires_at, revoked_at';

function toKey(row: KeyRow): ApiKeyRow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    prefix: row.prefix,
    keyHash: row.key_hash,
    scopes: row.scopes as Permission[],
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export function createApiKeyRepository(db: Queryable): ApiKeyRepository {
  return {
    async create(input) {
      await db.query(
        `INSERT INTO api_keys
           (id, organization_id, name, prefix, key_hash, scopes, workspace_id, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.id,
          input.organizationId,
          input.name,
          input.prefix,
          input.keyHash,
          input.scopes,
          input.workspaceId,
          input.createdBy,
          input.expiresAt,
        ],
      );
    },

    async findByPrefix(prefix) {
      const r = await db.query<KeyRow>(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE prefix = $1`, [
        prefix,
      ]);
      const row = r.rows[0];
      return row === undefined ? undefined : toKey(row);
    },

    async findById(organizationId, id) {
      const r = await db.query<KeyRow>(
        `SELECT ${KEY_COLUMNS} FROM api_keys WHERE organization_id = $1 AND id = $2`,
        [organizationId, id],
      );
      const row = r.rows[0];
      return row === undefined ? undefined : toKey(row);
    },

    async listForOrganization(organizationId) {
      const r = await db.query<Omit<KeyRow, 'key_hash'>>(
        `SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE organization_id = $1 ORDER BY created_at DESC`,
        [organizationId],
      );
      return r.rows.map((row) => {
        const { keyHash: _ignored, ...rest } = toKey({ ...row, key_hash: '' } as KeyRow);
        return rest;
      });
    },

    async revoke(organizationId, id, at) {
      // COALESCE keeps the FIRST revocation time; overwriting it rewrites history for an
      // incident investigation.
      const r = await db.query(
        `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, $3), updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, id, at],
      );
      return (r.rowCount ?? 0) === 1;
    },

    async touch(id, at) {
      await db.query('UPDATE api_keys SET last_used_at = $2 WHERE id = $1', [id, at]);
    },
  };
}
