-- 0003 — Identity.
--
-- Phase 1, per 06-identity-and-access.md §2 and 05-data-architecture.md §2 (Platform/tenancy).
--
-- These tables are GLOBAL, not tenant-scoped (05 §3 level 1): a user belongs to many
-- organizations, so a user row cannot carry an organization_id. That is why none of them
-- has RLS — there is no tenant column to write a predicate against. Isolation for identity
-- is enforced by the application layer, which never exposes a user row outside the
-- organizations that user is a member of. The membership tables that DO carry a tenant
-- (0004) are where RLS begins.
--
-- The discipline this file is buying: only hashes are ever stored. A dump of this schema
-- yields no usable session, no usable password, no usable recovery code and no usable
-- API key. That property is asserted by a test, not left to review.

-- ---------------------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------------------
CREATE TABLE users (
  id                  uuid        PRIMARY KEY,
  email               citext      NOT NULL,
  -- NULL for a user who has only ever signed in through an OAuth provider. Such a user has
  -- no password to verify, which the authn layer must handle explicitly rather than by
  -- comparing against an empty hash.
  password_hash       text        NULL,
  status              text        NOT NULL DEFAULT 'pending_verification'
                                  CHECK (status IN ('pending_verification', 'active',
                                                    'suspended', 'deactivated')),
  name                text        NULL,
  locale              text        NOT NULL DEFAULT 'en',
  timezone            text        NOT NULL DEFAULT 'UTC',
  mfa_enabled         boolean     NOT NULL DEFAULT false,
  email_verified_at   timestamptz NULL,
  last_login_at       timestamptz NULL,
  -- Lockout after repeated failures. Counted here rather than in Redis so the limit
  -- survives a cache flush: an attacker who can evict the cache must not reset the count.
  failed_login_count  integer     NOT NULL DEFAULT 0,
  locked_until        timestamptz NULL,
  metadata            jsonb       NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz NULL
);

-- Uniqueness must survive soft delete (05 §6 rule 6): a deactivated account must not block
-- the address forever, but two live accounts must never share one.
CREATE UNIQUE INDEX users_email_key ON users (email) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------------------
-- user_identities — OAuth / social login links
-- ---------------------------------------------------------------------------------------
CREATE TABLE user_identities (
  id                uuid        PRIMARY KEY,
  user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider          text        NOT NULL
                                CHECK (provider IN ('google', 'microsoft', 'github', 'apple')),
  provider_user_id  text        NOT NULL,
  -- Proving email ownership before linking is what stops an attacker who controls an
  -- unverified provider account from taking over an existing user (06 §2).
  email             citext      NULL,
  email_verified    boolean     NOT NULL DEFAULT false,
  linked_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX user_identities_provider_key
  ON user_identities (provider, provider_user_id);
CREATE INDEX user_identities_user_id_idx ON user_identities (user_id);

-- ---------------------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------------------
CREATE TABLE sessions (
  id                    uuid        PRIMARY KEY,
  user_id               uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Only sha256(token) is stored. A database leak therefore yields no usable session
  -- (06 §2). The raw token exists in the cookie and nowhere else.
  token_hash            bytea       NOT NULL,
  -- Sliding 30 days, absolute 90. Both are stored so the sliding renewal can never push a
  -- session past its absolute ceiling.
  expires_at            timestamptz NOT NULL,
  absolute_expires_at   timestamptz NOT NULL,
  -- The organization the session is currently acting in. Nullable because a session exists
  -- before an organization is chosen, and a user may belong to several.
  active_organization_id uuid       NULL,
  mfa_satisfied_at      timestamptz NULL,
  -- Set when a support user assumes this session. Every action taken under it is marked
  -- impersonated in audit_events, and billing mutations and credential reads are denied.
  impersonator_user_id  uuid        NULL REFERENCES users (id) ON DELETE SET NULL,
  impersonation_reason  text        NULL,
  impersonation_expires_at timestamptz NULL,
  ip                    inet        NULL,
  user_agent            text        NULL,
  device_label          text        NULL,
  last_used_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz NULL,
  revoked_reason        text        NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_absolute_ceiling CHECK (expires_at <= absolute_expires_at),
  -- Impersonation is time-boxed at the schema level (≤60 min is enforced in domain code;
  -- this constraint stops an unbounded one existing at all).
  CONSTRAINT sessions_impersonation_complete CHECK (
    (impersonator_user_id IS NULL AND impersonation_reason IS NULL
                                  AND impersonation_expires_at IS NULL)
    OR
    (impersonator_user_id IS NOT NULL AND impersonation_reason IS NOT NULL
                                      AND impersonation_expires_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
-- The device list query: a user's live sessions, most recently used first.
CREATE INDEX sessions_user_active_idx
  ON sessions (user_id, last_used_at DESC) WHERE revoked_at IS NULL;
-- The reaper's query.
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;
CREATE INDEX sessions_impersonator_id_idx
  ON sessions (impersonator_user_id) WHERE impersonator_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------
-- mfa_credentials
-- ---------------------------------------------------------------------------------------
CREATE TABLE mfa_credentials (
  id                uuid        PRIMARY KEY,
  user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type              text        NOT NULL CHECK (type IN ('totp', 'webauthn')),
  label             text        NULL,
  -- Encrypted with the application key, not merely hashed: TOTP verification needs the
  -- secret back. WebAuthn stores a public key here, which needs no secrecy but is kept in
  -- the same column for shape.
  secret_encrypted  bytea       NULL,
  credential_id     bytea       NULL,
  public_key        bytea       NULL,
  sign_count        bigint      NOT NULL DEFAULT 0,
  -- An unconfirmed credential must never satisfy an MFA challenge, or enrolment itself
  -- becomes the bypass.
  confirmed_at      timestamptz NULL,
  last_used_at      timestamptz NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mfa_credentials_user_id_idx ON mfa_credentials (user_id);
CREATE UNIQUE INDEX mfa_credentials_webauthn_key
  ON mfa_credentials (credential_id) WHERE credential_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------
-- mfa_recovery_codes — single-use, hashed
-- ---------------------------------------------------------------------------------------
CREATE TABLE mfa_recovery_codes (
  id          uuid        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash   bytea       NOT NULL,
  used_at     timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mfa_recovery_codes_user_id_idx ON mfa_recovery_codes (user_id);
CREATE UNIQUE INDEX mfa_recovery_codes_hash_key ON mfa_recovery_codes (user_id, code_hash);

-- ---------------------------------------------------------------------------------------
-- user_tokens — email verification, password reset, email change
-- ---------------------------------------------------------------------------------------
-- One table rather than three: the lifecycle is identical (issue a high-entropy token,
-- store only its hash, single use, short expiry) and three tables would be three chances to
-- get that lifecycle subtly different.
CREATE TABLE user_tokens (
  id          uuid        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose     text        NOT NULL
                          CHECK (purpose IN ('email_verification', 'password_reset',
                                             'email_change')),
  token_hash  bytea       NOT NULL,
  -- The address being moved to, for an email_change. NULL for the other purposes.
  new_email   citext      NULL,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX user_tokens_hash_key ON user_tokens (purpose, token_hash);
CREATE INDEX user_tokens_user_purpose_idx ON user_tokens (user_id, purpose)
  WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------
-- 0001 set default privileges for future tables, which covers these. Stated explicitly so
-- the grant posture of identity tables is reviewable in one place rather than inferred.
GRANT SELECT, INSERT, UPDATE, DELETE ON users, user_identities, sessions,
  mfa_credentials, mfa_recovery_codes, user_tokens TO growth_os_app;
