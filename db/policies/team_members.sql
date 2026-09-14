-- team_members
--
-- WHO MAY READ:  any member of the organization.
-- WHO MAY WRITE: any member of the organization, subject to application authorization.
--
-- Carries organization_id even though it is reachable through team_id, so the predicate is
-- a column comparison rather than a join. That is what keeps the three-level hierarchy
-- cheap at query time (05-data-architecture.md §1).
--
-- Symmetric: the read rule and the write rule are the same expression. WITH CHECK is
-- stated explicitly anyway, per the rule in README.md — not because omitting it would leak
-- here (PostgreSQL would reuse USING), but so the write rule is a deliberate statement
-- rather than an inheritance.
--
-- canonical-using:      (organization_id = app_current_organization_id())
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON team_members
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
