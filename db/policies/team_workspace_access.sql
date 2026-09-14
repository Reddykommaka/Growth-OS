-- team_workspace_access
--
-- WHO MAY READ:  any member of the organization.
-- WHO MAY WRITE: any member of the organization, subject to application authorization.
--
-- NOT filtered by the accessible-workspace set, deliberately: this table is an INPUT to
-- computing that set. Filtering it by the set it produces would be circular and would make
-- the resolver unable to read the grants it exists to expand.
--
-- Symmetric: the read rule and the write rule are the same expression. WITH CHECK is
-- stated explicitly anyway, per the rule in README.md — not because omitting it would leak
-- here (PostgreSQL would reuse USING), but so the write rule is a deliberate statement
-- rather than an inheritance.
--
-- canonical-using:      (organization_id = app_current_organization_id())
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE team_workspace_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_workspace_access FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON team_workspace_access
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
