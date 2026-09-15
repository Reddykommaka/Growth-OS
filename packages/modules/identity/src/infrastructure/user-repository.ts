/** Users: lookup, creation, lockout state and status transitions. */

import type { CreateUserInput, UserRecord, UserRepository } from '../application/ports.js';
import type { UserStatus } from '../domain/index.js';
import type { Queryable } from './queryable.js';

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  status: string;
  name: string | null;
  mfa_enabled: boolean;
  email_verified_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
}

const USER_COLUMNS =
  'id, email, password_hash, status, name, mfa_enabled, email_verified_at, ' +
  'failed_login_count, locked_until';

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    status: row.status as UserStatus,
    name: row.name,
    mfaEnabled: row.mfa_enabled,
    emailVerifiedAt: row.email_verified_at,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
  };
}

export function createUserRepository(db: Queryable): UserRepository {
  return {
    async findByEmail(email) {
      // `citext` makes this case-insensitive in the database; deleted_at excludes a
      // soft-deleted account so its address can be reused without resurrecting it.
      const r = await db.query<UserRow>(
        `SELECT ${USER_COLUMNS} FROM users WHERE email = $1 AND deleted_at IS NULL`,
        [email],
      );
      const row = r.rows[0];
      return row === undefined ? undefined : toUser(row);
    },

    async findById(id) {
      const r = await db.query<UserRow>(
        `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      const row = r.rows[0];
      return row === undefined ? undefined : toUser(row);
    },

    async create(input: CreateUserInput) {
      const r = await db.query<UserRow>(
        `INSERT INTO users (id, email, password_hash, name, status)
           VALUES ($1, $2, $3, $4, $5)
         RETURNING ${USER_COLUMNS}`,
        [input.id, input.email, input.passwordHash, input.name ?? null, input.status],
      );
      const row = r.rows[0];
      if (row === undefined) throw new Error('Inserting the user returned no row.');
      return toUser(row);
    },

    async updateLockout(userId, state) {
      await db.query(
        `UPDATE users SET failed_login_count = $2, locked_until = $3, updated_at = now()
          WHERE id = $1`,
        [userId, state.failedLoginCount, state.lockedUntil],
      );
    },

    async markSignedIn(userId, at) {
      await db.query('UPDATE users SET last_login_at = $2, updated_at = now() WHERE id = $1', [
        userId,
        at,
      ]);
    },

    async markEmailVerified(userId, at) {
      // Promotes pending_verification to active in the same statement, so the two can never
      // disagree — a verified user stuck as pending cannot sign in.
      await db.query(
        `UPDATE users
            SET email_verified_at = COALESCE(email_verified_at, $2),
                status = CASE WHEN status = 'pending_verification' THEN 'active' ELSE status END,
                updated_at = now()
          WHERE id = $1`,
        [userId, at],
      );
    },

    async setPasswordHash(userId, passwordHash) {
      await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
        userId,
        passwordHash,
      ]);
    },

    async setMfaEnabled(userId, enabled) {
      await db.query('UPDATE users SET mfa_enabled = $2, updated_at = now() WHERE id = $1', [
        userId,
        enabled,
      ]);
    },

    async setStatus(userId, status) {
      await db.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [
        userId,
        status,
      ]);
    },

    async setEmail(userId, email, verifiedAt) {
      await db.query(
        'UPDATE users SET email = $2, email_verified_at = $3, updated_at = now() WHERE id = $1',
        [userId, email, verifiedAt],
      );
    },
  };
}
