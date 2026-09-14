-- invitations
--
-- WHO MAY READ:  any member of the organization that issued the invitation.
-- WHO MAY WRITE: any member of the organization, subject to application authorization.
--
-- An invitation is accepted by someone who is NOT yet a member, so acceptance runs on a
-- path that looks the invitation up by token hash outside tenant context, in a narrowly
-- scoped service operation — never by relaxing this policy.
--
-- Symmetric: the read rule and the write rule are the same expression. WITH CHECK is
-- stated explicitly anyway, per the rule in README.md — not because omitting it would leak
-- here (PostgreSQL would reuse USING), but so the write rule is a deliberate statement
-- rather than an inheritance.
--
-- canonical-using:      (organization_id = app_current_organization_id())
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invitations
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
