/** Single-use tokens: email verification, password reset and email change. */

import type { UserTokenRepository, UserTokenRow } from '../application/ports.js';
import type { UserTokenPurpose } from '../domain/index.js';
import type { Queryable } from './queryable.js';

export function createUserTokenRepository(db: Queryable): UserTokenRepository {
  return {
    async create(input) {
      await db.query(
        `INSERT INTO user_tokens (id, user_id, purpose, token_hash, expires_at, new_email)
           VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.id,
          input.userId,
          input.purpose,
          input.tokenHash,
          input.expiresAt,
          input.newEmail ?? null,
        ],
      );
    },

    async findUnconsumed(purpose, tokenHash) {
      const r = await db.query<{
        id: string;
        user_id: string;
        purpose: string;
        new_email: string | null;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        `SELECT id, user_id, purpose, new_email, expires_at, consumed_at
           FROM user_tokens
          WHERE purpose = $1 AND token_hash = $2 AND consumed_at IS NULL`,
        [purpose, tokenHash],
      );
      const row = r.rows[0];
      if (row === undefined) return undefined;
      return {
        id: row.id,
        userId: row.user_id,
        purpose: row.purpose as UserTokenPurpose,
        newEmail: row.new_email,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at,
      } satisfies UserTokenRow;
    },

    /**
     * Single-use, settled by the DATABASE.
     *
     * The `consumed_at IS NULL` predicate is what makes this safe: two concurrent requests
     * presenting the same token both pass a read-then-write check, but only one can match
     * this UPDATE. The loser gets rowCount 0 and is told the token is already used.
     */
    async consume(tokenId, at) {
      const r = await db.query(
        'UPDATE user_tokens SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL',
        [tokenId, at],
      );
      return (r.rowCount ?? 0) === 1;
    },

    async invalidateAllFor(userId, purpose, at) {
      const r = await db.query(
        `UPDATE user_tokens SET consumed_at = $3
          WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
        [userId, purpose, at],
      );
      return r.rowCount ?? 0;
    },
  };
}
