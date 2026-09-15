-- workspaces — THE RESOURCE BOUNDARY
--
-- WHO MAY READ:  a member acting inside the owning organization, AND either
--                  (a) the workspace is in that actor's resolved accessible set, or
--                  (b) the actor holds organization-wide workspace access.
-- WHO MAY WRITE: a member acting inside the owning organization, subject to application
--                authorization.
--
-- This policy was WRONG TWICE before it was right, and both mistakes are worth keeping
-- visible, because each is easy to make again.
--
-- ATTEMPT 1 (migration 0004, as first written) — `AND id = ANY(app_current_workspace_ids())`.
-- Circular. The accessible set is computed BY READING THIS TABLE: a team's owned workspaces
-- come from workspaces.team_id. A policy demanding the set makes the set underivable, and
-- every actor resolved to an empty set — the organization's owner included, locked out of
-- the tenant they had just created.
--
-- ATTEMPT 2 (migration 0004, as corrected) — the plain organization predicate. Not circular,
-- but it left an authorization boundary defect: ANY session could enumerate every workspace
-- row in its own tenant with raw SQL regardless of its accessible set. A client_guest —
-- someone outside the tenant organization entirely — could read the agency's whole client
-- list.
--
-- THIS VERSION (migration 0007) breaks the circle with a third setting rather than by
-- weakening the predicate. `app.workspace_scope` separates the two situations that attempt 1
-- conflated:
--
--   'set'  — an ordinary application session. Readable workspaces are exactly
--            app.workspace_ids. This is the DEFAULT; an unset value is NOT 'all'.
--   'all'  — organization-wide reach, for exactly two callers:
--              1. the actor-context resolver, which runs BEFORE any session exists and must
--                 read the team→workspace topology to compute the set in the first place.
--                 It reads ids and team ids, and returns a computed set — never rows.
--              2. a session whose actor genuinely holds organization-wide workspace access,
--                 for whom the set IS every workspace, making 'all' and the enumeration
--                 equivalent.
--
-- "Organization-wide workspace access" means an organization-scoped role granting at least
-- one WORKSPACE-SCOPED permission — not merely an organization-scoped assignment. `member`
-- is organization-scoped and grants only organization.organization:read; counting it as
-- tenant-wide was a second defect, fixed alongside this one.
--
-- WHY THE ASYMMETRY IS SAFE. USING is narrower than WITH CHECK. The broader rule governs
-- only what this tenant may write into its OWN organization, which it may already do. The
-- dangerous direction is the reverse — a USING broader than the write rule, as on
-- marketplace listings — and this is not that.
--
-- FAILS CLOSED. current_setting(..., true) is NULL when unset; NULL = 'all' is NULL, not
-- true, so the predicate falls through to the set check, and an unset set is an empty array
-- that matches nothing.
--
-- canonical-using:      ((organization_id = app_current_organization_id()) AND (app_workspace_scope_is_all() OR (id = ANY (app_current_workspace_ids()))))
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON workspaces
  USING      (organization_id = app_current_organization_id()
              AND (app_workspace_scope_is_all() OR id = ANY (app_current_workspace_ids())))
  WITH CHECK (organization_id = app_current_organization_id());
