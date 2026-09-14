-- organization_members
--
-- WHO MAY READ:  any member of the organization.
-- WHO MAY WRITE: any member of the organization, subject to application authorization.
--
-- Membership is what makes someone a tenant at all, so it is scoped by organization only.
-- Which members a given actor may SEE is an application concern (a client_guest is denied
-- the member-list permission outright); the database's job here is the tenant boundary.
--
-- Symmetric: the read rule and the write rule are the same expression. WITH CHECK is
-- stated explicitly anyway, per the rule in README.md — not because omitting it would leak
-- here (PostgreSQL would reuse USING), but so the write rule is a deliberate statement
-- rather than an inheritance.
--
-- canonical-using:      (organization_id = app_current_organization_id())
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON organization_members
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
