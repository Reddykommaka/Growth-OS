-- workspaces — THE RESOURCE BOUNDARY
--
-- WHO MAY READ:  a member of the owning organization, AND only the workspaces in that
--                actor's resolved accessible-workspace set.
-- WHO MAY WRITE: a member of the owning organization (application authorization decides
--                who may create or modify one).
--
-- ASYMMETRIC, IN THE SAFE DIRECTION. USING is NARROWER than the write rule.
--
-- Why USING is narrower: this is what stops a client_guest — someone outside the tenant
-- organization entirely, reviewing their own brand's content — from learning that the
-- agency's other clients exist. Enforcing it in the database rather than only in the
-- application means a missed authz check becomes a permissions bug, not a client list leak.
--
-- Why WITH CHECK is broader: a workspace must be creatable before it can appear in anyone's
-- accessible set. Requiring set membership on INSERT would make the first workspace
-- impossible to create, and onboarding would deadlock.
--
-- Why the asymmetry cannot leak: the BROADER rule governs writes, and it grants only what
-- the tenant may already do — write into its own organization. The dangerous shape is the
-- reverse (a USING broader than the write rule, as on marketplace listings), and a test
-- asserts this policy is not that one.
--
-- Fails closed: with app.workspace_ids unset, app_current_workspace_ids() returns an empty
-- array, `id = ANY('{}')` is false, and the table returns zero rows.
--
-- canonical-using:      ((organization_id = app_current_organization_id()) AND (id = ANY (app_current_workspace_ids())))
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON workspaces
  USING      (organization_id = app_current_organization_id()
              AND id = ANY (app_current_workspace_ids()))
  WITH CHECK (organization_id = app_current_organization_id());
