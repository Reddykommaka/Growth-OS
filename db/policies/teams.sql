-- teams
--
-- WHO MAY READ:  any member of the organization that owns the team.
-- WHO MAY WRITE: any member of the organization, subject to application authorization.
--
-- Teams are an access-EXPANSION mechanism, so they are never themselves filtered by the
-- accessible-workspace set — a member must be able to see the team they belong to in order
-- for the resolver to expand it.
--
-- Symmetric: the read rule and the write rule are the same expression. WITH CHECK is
-- stated explicitly anyway, per the rule in README.md — not because omitting it would leak
-- here (PostgreSQL would reuse USING), but so the write rule is a deliberate statement
-- rather than an inheritance.
--
-- canonical-using:      (organization_id = app_current_organization_id())
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON teams
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
