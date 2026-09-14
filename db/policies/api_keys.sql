-- api_keys
--
-- WHO MAY READ:  any member of the organization that owns the key.
-- WHO MAY WRITE: any member of the organization, subject to application authorization.
--
-- Only the Argon2 hash of the secret half is stored, so a read of this table yields no
-- usable credential. The key is displayed once at creation and is unrecoverable after.
--
-- Symmetric: the read rule and the write rule are the same expression. WITH CHECK is
-- stated explicitly anyway, per the rule in README.md — not because omitting it would leak
-- here (PostgreSQL would reuse USING), but so the write rule is a deliberate statement
-- rather than an inheritance.
--
-- canonical-using:      (organization_id = app_current_organization_id())
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON api_keys
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
