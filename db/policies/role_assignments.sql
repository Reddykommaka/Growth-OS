-- role_assignments
--
-- WHO MAY READ:  any member of the organization.
-- WHO MAY WRITE: any member of the organization, subject to application authorization.
--
-- Same reasoning as team_workspace_access: an input to the resolver, so it cannot be
-- filtered by the resolver's output.
--
-- Symmetric: the read rule and the write rule are the same expression. WITH CHECK is
-- stated explicitly anyway, per the rule in README.md — not because omitting it would leak
-- here (PostgreSQL would reuse USING), but so the write rule is a deliberate statement
-- rather than an inheritance.
--
-- canonical-using:      (organization_id = app_current_organization_id())
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignments FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON role_assignments
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
