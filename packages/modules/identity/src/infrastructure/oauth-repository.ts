/** OAuth authorization requests and linked provider identities. */
import type {
  OAuthPurpose,
  OAuthRequestRepository,
  OAuthRequestRow,
  ProviderId,
  UserIdentityRepository,
  UserIdentityRow,
} from '../application/oauth-port.js';
import type { Queryable } from './queryable.js';

interface RequestRow {
  id: string;
  provider: string;
  pkce_verifier_encrypted: Buffer;
  nonce_encrypted: Buffer;
  redirect_uri: string;
  purpose: string;
  link_user_id: string | null;
  expires_at: Date;
  consumed_at: Date | null;
}

export function createOAuthRequestRepository(db: Queryable): OAuthRequestRepository {
  return {
    async create(input) {
      await db.query(
        `INSERT INTO oauth_authorization_requests
           (id, provider, state_hash, pkce_verifier_encrypted, nonce_encrypted, redirect_uri,
            purpose, link_user_id, ip, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::inet, $10, $11)`,
        [
          input.id,
          input.provider,
          input.stateHash,
          input.pkceVerifierEncrypted,
          input.nonceEncrypted,
          input.redirectUri,
          input.purpose,
          input.linkUserId ?? null,
          input.ip ?? null,
          input.userAgent ?? null,
          input.expiresAt,
        ],
      );
    },

    async findByStateHash(stateHash) {
      const r = await db.query<RequestRow>(
        `SELECT id, provider, pkce_verifier_encrypted, nonce_encrypted, redirect_uri, purpose,
                link_user_id, expires_at, consumed_at
           FROM oauth_authorization_requests
          WHERE state_hash = $1`,
        [stateHash],
      );
      const row = r.rows[0];
      if (row === undefined) return undefined;
      return {
        id: row.id,
        provider: row.provider,
        pkceVerifierEncrypted: row.pkce_verifier_encrypted,
        nonceEncrypted: row.nonce_encrypted,
        redirectUri: row.redirect_uri,
        purpose: row.purpose as OAuthPurpose,
        linkUserId: row.link_user_id,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at,
      } satisfies OAuthRequestRow;
    },

    /**
     * Single-use, settled by the database.
     *
     * `consumed_at IS NULL` is what makes a replayed callback lose: two requests carrying the
     * same state both pass a read-then-write check, but only one can match this UPDATE.
     */
    async consume(id, at) {
      const r = await db.query(
        'UPDATE oauth_authorization_requests SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL',
        [id, at],
      );
      return (r.rowCount ?? 0) === 1;
    },

    async deleteExpired(before) {
      const r = await db.query('DELETE FROM oauth_authorization_requests WHERE expires_at < $1', [
        before,
      ]);
      return r.rowCount ?? 0;
    },
  };
}

interface IdentityRow {
  id: string;
  user_id: string;
  provider: string;
  provider_user_id: string;
  email: string | null;
  email_verified: boolean;
}

const IDENTITY_COLUMNS = 'id, user_id, provider, provider_user_id, email, email_verified';

function toIdentity(row: IdentityRow): UserIdentityRow {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    email: row.email,
    emailVerified: row.email_verified,
  };
}

export function createUserIdentityRepository(db: Queryable): UserIdentityRepository {
  return {
    async findByProviderSubject(provider: ProviderId, providerUserId: string) {
      // The durable join key. Covered by the unique index from migration 0003, which is also
      // what stops one provider subject being linked to two users.
      const r = await db.query<IdentityRow>(
        `SELECT ${IDENTITY_COLUMNS} FROM user_identities
          WHERE provider = $1 AND provider_user_id = $2`,
        [provider, providerUserId],
      );
      const row = r.rows[0];
      return row === undefined ? undefined : toIdentity(row);
    },

    async listForUser(userId) {
      const r = await db.query<IdentityRow>(
        `SELECT ${IDENTITY_COLUMNS} FROM user_identities WHERE user_id = $1 ORDER BY provider`,
        [userId],
      );
      return r.rows.map(toIdentity);
    },

    async link(input) {
      await db.query(
        `INSERT INTO user_identities
           (id, user_id, provider, provider_user_id, email, email_verified, linked_at, last_used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [
          input.id,
          input.userId,
          input.provider,
          input.providerUserId,
          input.email ?? null,
          input.emailVerified,
          input.at,
        ],
      );
    },

    async recordUse(id, at, email, emailVerified) {
      // Updates the IDENTITY's record of the address only. The user's account email is never
      // touched here — see shouldUpdateIdentityEmail for why that would be a takeover.
      await db.query(
        `UPDATE user_identities
            SET last_used_at = $2, email = $3, email_verified = $4, updated_at = now()
          WHERE id = $1`,
        [id, at, email ?? null, emailVerified],
      );
    },

    async unlink(userId, provider) {
      const r = await db.query('DELETE FROM user_identities WHERE user_id = $1 AND provider = $2', [
        userId,
        provider,
      ]);
      return (r.rowCount ?? 0) > 0;
    },
  };
}
