/** MFA credentials and recovery codes, including the TOTP replay guard. */
import type { MfaCredentialRow, MfaRepository } from '../application/ports.js';
import type { Queryable } from './queryable.js';

interface MfaRow {
  id: string;
  user_id: string;
  type: string;
  label: string | null;
  secret_encrypted: Buffer | null;
  confirmed_at: Date | null;
  last_used_at: Date | null;
  last_totp_counter: string | null;
}

export function createMfaRepository(db: Queryable): MfaRepository {
  return {
    async createTotp(input) {
      await db.query(
        `INSERT INTO mfa_credentials (id, user_id, type, secret_encrypted, label)
           VALUES ($1, $2, 'totp', $3, $4)`,
        [input.id, input.userId, input.secretEncrypted, input.label ?? null],
      );
    },

    async findTotpForUser(userId) {
      const r = await db.query<MfaRow>(
        `SELECT id, user_id, type, label, secret_encrypted, confirmed_at, last_used_at,
                last_totp_counter
           FROM mfa_credentials
          WHERE user_id = $1 AND type = 'totp'
          ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      const row = r.rows[0];
      if (row === undefined) return undefined;
      return {
        id: row.id,
        userId: row.user_id,
        type: 'totp',
        label: row.label,
        secretEncrypted: row.secret_encrypted,
        confirmedAt: row.confirmed_at,
        lastUsedAt: row.last_used_at,
        lastCounter: row.last_totp_counter,
      } satisfies MfaCredentialRow;
    },

    async confirm(credentialId, at, counter) {
      await db.query(
        `UPDATE mfa_credentials
            SET confirmed_at = $2, last_used_at = $2, last_totp_counter = $3, updated_at = now()
          WHERE id = $1`,
        [credentialId, at, counter.toString()],
      );
    },

    /**
     * Records an accepted counter, refusing one already seen.
     *
     * The `last_totp_counter IS NULL OR last_totp_counter < $3` predicate is the replay
     * guard, and it lives in the UPDATE rather than in a prior read for the same reason
     * token consumption does: two requests with the same intercepted code race, and exactly
     * one must win.
     */
    async recordUse(credentialId, at, counter) {
      const r = await db.query(
        `UPDATE mfa_credentials
            SET last_used_at = $2, last_totp_counter = $3, updated_at = now()
          WHERE id = $1
            AND (last_totp_counter IS NULL OR last_totp_counter < $3)`,
        [credentialId, at, counter.toString()],
      );
      return (r.rowCount ?? 0) === 1;
    },

    async deleteForUser(userId) {
      await db.query(`DELETE FROM mfa_credentials WHERE user_id = $1 AND type = 'totp'`, [userId]);
      await db.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
    },

    async replaceRecoveryCodes(userId, hashes) {
      await db.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
      for (const hash of hashes) {
        await db.query(
          'INSERT INTO mfa_recovery_codes (id, user_id, code_hash) VALUES (gen_random_uuid(), $1, $2)',
          [userId, hash],
        );
      }
    },

    /** Single-use, decided by the write. Same race, same remedy. */
    async consumeRecoveryCode(userId, codeHash, at) {
      const r = await db.query(
        `UPDATE mfa_recovery_codes SET used_at = $3
          WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
        [userId, codeHash, at],
      );
      return (r.rowCount ?? 0) === 1;
    },

    async countUnusedRecoveryCodes(userId) {
      const r = await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL',
        [userId],
      );
      return Number(r.rows[0]?.count ?? 0);
    },
  };
}
