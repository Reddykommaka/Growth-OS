-- workspaces — THE RESOURCE BOUNDARY
--
-- WHO MAY READ:  any member acting inside the owning organization.
-- WHO MAY WRITE: the same, subject to application authorization.
--
-- ORGANIZATION-SCOPED — level 2 in 05-data-architecture.md §3, not level 3.
--
-- Level 3 ("workspace-scoped") is defined there as a table that "additionally [has]
-- workspace_id NOT NULL", where RLS adds membership of the actor's accessible-workspace
-- set. This table has no workspace_id column; it IS the workspace. So the predicate is the
-- plain tenant one, symmetric, and the set plays no part.
--
-- WHY NOT RESTRICT READS TO THE ACCESSIBLE SET.
--
-- It was tried, during Phase 1, with the intent of stopping a client_guest from learning
-- that the agency's other clients exist. It is circular and cannot work: a team's reachable
-- workspaces are read from workspaces.team_id, so the set is COMPUTED FROM THIS TABLE. A
-- policy demanding the set makes the set underivable, and the resolver returns empty for
-- every actor — including the organization's owner, who is then locked out of the tenant
-- they created.
--
-- WHERE THE CONTAINMENT ACTUALLY LIVES.
--
--   1. The authorization engine denies any workspace outside the resolved set before a
--      query is issued, with reason `workspace_not_accessible`.
--   2. Every workspace-SCOPED table — one carrying workspace_id: content, campaigns,
--      reports, from Phase 3 onward — is level 3 and IS restricted by the set in RLS. A
--      guest cannot read another client's work even if the application check were bypassed.
--
-- RESIDUAL RISK, STATED PLAINLY: with the application check bypassed, a session could
-- enumerate workspace NAMES within its own organization. It could not reach another
-- tenant's, and it could not read any workspace's contents. That is the accepted level-2
-- posture for this table.
--
-- canonical-using:      (organization_id = app_current_organization_id())
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON workspaces
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
