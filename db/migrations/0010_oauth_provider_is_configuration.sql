-- 0010 — Stop the schema enumerating OAuth providers.
--
-- 0003 wrote `CHECK (provider IN ('google','microsoft','github','apple'))` on
-- user_identities. That was wrong, and a test caught it: a deployment that federates with
-- Okta, Auth0, Entra ID or a customer's own OIDC issuer could not store the resulting
-- identity without a schema migration.
--
-- The set of login providers is DEPLOYMENT CONFIGURATION, not a domain state machine.
-- 05-data-architecture.md §1 says enums are "text + CHECK, or a lookup table", and that rule
-- is about states with fixed, product-defined meaning — `draft → published`, where an
-- unrecognised value is a bug. A provider id is the opposite: an installation is expected to
-- add one, and the authoritative list lives in the provider registry the application is
-- configured with.
--
-- Membership is still validated, just in the layer that knows the answer: `beginOAuth`
-- refuses an id the registry does not hold, so nothing unconfigured can reach a callback.
-- What remains here is a FORMAT constraint, which is the part the database can actually
-- enforce without knowing the deployment.

ALTER TABLE user_identities DROP CONSTRAINT user_identities_provider_check;

ALTER TABLE user_identities
  ADD CONSTRAINT user_identities_provider_format
  CHECK (provider ~ '^[a-z0-9][a-z0-9_-]{0,62}$');

COMMENT ON COLUMN user_identities.provider IS
  'OAuth/OIDC provider id, matching an entry in the application''s configured provider '
  'registry. Deliberately not constrained to a fixed list: adding a provider is '
  'configuration, not a migration.';
