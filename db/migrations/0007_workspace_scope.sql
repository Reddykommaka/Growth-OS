-- 0007 — Close the workspace enumeration boundary.
--
-- SECURITY FIX. Until this migration, `workspaces` carried only the organization predicate,
-- so ANY session could read every workspace row in its own tenant with raw SQL regardless of
-- its accessible set. Not cross-tenant, but an authorization boundary defect: a client_guest
-- — someone outside the tenant organization entirely — could enumerate the agency's whole
-- client list.
--
-- WHY THE OBVIOUS FIX DOES NOT WORK.
--
-- Adding `AND id = ANY(app_current_workspace_ids())` to USING is circular. The accessible
-- set is computed BY READING THIS TABLE (a team's owned workspaces come from
-- workspaces.team_id), so a policy demanding the set makes the set underivable. That was
-- tried in 0004 and reverted: every actor resolved to an empty set, the organization's owner
-- included.
--
-- HOW THIS BREAKS THE CIRCLE.
--
-- A third setting, `app.workspace_scope`, distinguishes the two situations that were
-- previously conflated:
--
--   'set'  — an ordinary application session. Readable workspaces are exactly
--            app.workspace_ids. This is the DEFAULT: an unset value is not 'all'.
--   'all'  — organization-wide reach. Used by exactly two callers:
--              1. the actor-context resolver, which runs BEFORE a session exists and must
--                 read the team→workspace topology to compute the set in the first place;
--              2. a session whose actor genuinely holds organization-wide workspace access,
--                 for whom the set IS every workspace, making the two equivalent.
--
-- The resolver's use is narrow and auditable: one function, reading ids and team ids, which
-- never returns rows to a caller — it returns a computed set. An architecture test asserts
-- that the only code that may request this scope is @growth-os/db's withOrganizationScope,
-- and that its only caller is the resolver.
--
-- FAILS CLOSED. current_setting(..., true) returns NULL when unset; NULL = 'all' is NULL,
-- which is not true, so the predicate falls through to the set check — and an unset
-- workspace set is an empty array, which matches nothing.

CREATE OR REPLACE FUNCTION app_workspace_scope_is_all() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT COALESCE(NULLIF(current_setting('app.workspace_scope', true), ''), 'set') = 'all' $$;

GRANT EXECUTE ON FUNCTION app_workspace_scope_is_all() TO growth_os_app;

DROP POLICY tenant_isolation ON workspaces;

CREATE POLICY tenant_isolation ON workspaces
  USING      (organization_id = app_current_organization_id()
              AND (app_workspace_scope_is_all() OR id = ANY (app_current_workspace_ids())))
  -- The write rule stays the plain tenant predicate: a workspace must be creatable before it
  -- can appear in anybody's set, so requiring set membership on INSERT would deadlock
  -- onboarding. Narrowing USING relative to WITH CHECK cannot leak — the broader rule governs
  -- only what this tenant may write into its OWN organization, which it may already do.
  WITH CHECK (organization_id = app_current_organization_id());
