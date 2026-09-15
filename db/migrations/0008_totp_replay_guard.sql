-- 0008 — TOTP replay guard.
--
-- A TOTP code is valid for its whole 30-second period, so an intercepted code works a second
-- time within that window unless the accepted counter is recorded and refused thereafter.
-- RFC 6238 §5.2 requires exactly this of a verifier:
--
--   "The verifier MUST NOT accept the second attempt of the OTP after the successful
--    validation has been issued for the first OTP."
--
-- `sign_count` already exists on this table but belongs to WebAuthn, where it means
-- something else entirely (an authenticator's monotonic use counter, used to detect cloned
-- hardware). Overloading it would make both meanings unreadable.
--
-- Nullable with no default, because a credential that has never been used correctly has no
-- last counter — and a default of 0 would be indistinguishable from "used at the Unix
-- epoch", which is a real counter value.
ALTER TABLE mfa_credentials ADD COLUMN last_totp_counter bigint NULL;

COMMENT ON COLUMN mfa_credentials.last_totp_counter IS
  'The last TOTP counter accepted for this credential. A code at or below this counter is '
  'refused as a replay (RFC 6238 §5.2). Distinct from sign_count, which is WebAuthn''s '
  'cloned-authenticator detector.';
