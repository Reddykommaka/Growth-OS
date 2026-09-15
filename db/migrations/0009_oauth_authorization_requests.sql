-- 0009 — OAuth authorization requests.
--
-- One row per in-flight OAuth login or link. It holds the values the callback must check the
-- response against — state, PKCE verifier, nonce — and nothing else.
--
-- WHAT THIS TABLE DELIBERATELY DOES NOT HOLD: provider access tokens or refresh tokens.
--
-- OAuth LOGIN is identity federation, not an integration. We exchange the code once, verify
-- the ID token, take the subject and email, and discard the tokens. There is nothing to
-- refresh, because we never call the provider again on the user's behalf — so storing them
-- would create a credential to protect for no benefit whatsoever.
--
-- That is a different thing from a workspace CONNECTION (07-integration-architecture.md
-- §2-§3), where an agency connects its client's Instagram account and we do keep calling the
-- provider. Those tokens live in `integration_credentials` under envelope encryption, arrive
-- in Phase 2, and share nothing with this table but the word "OAuth".
--
-- GLOBAL, not tenant-scoped (05-data-architecture.md §3 level 1). An OAuth login happens
-- before any organization is chosen — there is no tenant to scope to yet, which is also why
-- there is no RLS here. Every row is addressed by a 256-bit state hash that the caller must
-- already possess.

CREATE TABLE oauth_authorization_requests (
  id                      uuid        PRIMARY KEY,
  provider                text        NOT NULL,
  -- Only sha256(state) is stored, exactly as for every other token in this system: a
  -- database leak yields no state value that could be replayed into a callback.
  state_hash              bytea       NOT NULL,
  -- The PKCE verifier is a secret for the lifetime of the request: an attacker who steals an
  -- authorization code still cannot exchange it without the verifier, which is the entire
  -- point of PKCE. Encrypted rather than hashed because the token exchange needs it back.
  pkce_verifier_encrypted bytea       NOT NULL,
  -- Binds the ID token to this request, closing ID-token replay across sessions.
  nonce_encrypted         bytea       NOT NULL,
  -- Recorded so the callback can prove the response came back to the same URI the
  -- authorization request named, rather than one an attacker substituted.
  redirect_uri            text        NOT NULL,
  purpose                 text        NOT NULL CHECK (purpose IN ('sign_in', 'link')),
  -- Set only for 'link': the already-authenticated user this identity will attach to. An
  -- account is never linked to a user chosen by the callback.
  link_user_id            uuid        NULL REFERENCES users (id) ON DELETE CASCADE,
  ip                      inet        NULL,
  user_agent              text        NULL,
  expires_at              timestamptz NOT NULL,
  consumed_at             timestamptz NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  -- 'link' must name its user; 'sign_in' must not carry one, or a forged request could
  -- nominate whose account an identity attaches to.
  CONSTRAINT oauth_requests_link_has_user CHECK (
    (purpose = 'link' AND link_user_id IS NOT NULL)
    OR (purpose = 'sign_in' AND link_user_id IS NULL)
  )
);

CREATE UNIQUE INDEX oauth_authorization_requests_state_key
  ON oauth_authorization_requests (state_hash);
CREATE INDEX oauth_authorization_requests_link_user_id_idx
  ON oauth_authorization_requests (link_user_id) WHERE link_user_id IS NOT NULL;
-- The reaper's query: delete what has expired, so a stolen database row is useless within
-- minutes rather than forever.
CREATE INDEX oauth_authorization_requests_expiry_idx
  ON oauth_authorization_requests (expires_at) WHERE consumed_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_authorization_requests TO growth_os_app;

-- NOTE: no index is added to user_identities here. Identity resolution keys on
-- (provider, provider_user_id), which 0003 already covers with a unique index. An index on
-- its `email` column would be speculative — nothing queries it — and adding one would need
-- the migration runner's no-transaction mode, which does not exist yet. Neither cost is
-- worth paying for a query that is not made.
