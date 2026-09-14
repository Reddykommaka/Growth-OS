-- resource_grants
--
-- WHO MAY READ:  any member of the organization.
-- WHO MAY WRITE: any member of the organization, subject to application authorization.
--
-- Fine-grained sharing of a single resource. Scoped to the organization only; whether a
-- specific grant applies to a specific actor is decided in the policy engine.
--
-- Symmetric: the read rule and the write rule are the same expression. WITH CHECK is
-- stated explicitly anyway, per the rule in README.md — not because omitting it would leak
-- here (PostgreSQL would reuse USING), but so the write rule is a deliberate statement
-- rather than an inheritance.
--
-- canonical-using:      (organization_id = app_current_organization_id())
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE resource_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_grants FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON resource_grants
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
