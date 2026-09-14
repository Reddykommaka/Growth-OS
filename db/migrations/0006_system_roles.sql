-- 0006 — System role rows.
--
-- Seeds the thirteen built-in roles from 06-identity-and-access.md §3 as shared rows with
-- organization_id NULL, readable by every tenant through the roles policy in 0005.
--
-- WHAT IS SEEDED HERE AND WHAT IS NOT.
--
-- Only the ROLE rows live in the database. Their PERMISSION SETS live in code, in
-- @growth-os/authz SYSTEM_ROLES, and are not written to role_permissions.
--
-- That split is deliberate and is the same reasoning that makes these rows shared rather
-- than copied per organization: if a system role's permissions were rows, adding a
-- permission to `editor` would require a data migration that reaches every tenant, and any
-- tenant created before it would silently keep the old set. Keeping the sets in code means
-- the change ships with the release that needs it.
--
-- role_permissions therefore holds CUSTOM role permissions only. A drift test asserts these
-- rows and SYSTEM_ROLES agree on slug and scope, so a role added in code without a row here
-- — which would be unassignable, since role_assignments carries an FK to roles — fails CI.
--
-- The ids are fixed rather than generated so an assignment referencing `editor` means the
-- same thing in every database, including a developer's disposable one.

INSERT INTO roles (id, organization_id, slug, name, scope, is_system) VALUES
  ('01900000-0000-7000-8000-000000000001', NULL, 'owner', 'Owner', 'organization', true),
  ('01900000-0000-7000-8000-000000000002', NULL, 'admin', 'Administrator', 'organization', true),
  ('01900000-0000-7000-8000-000000000003', NULL, 'billing', 'Billing', 'organization', true),
  ('01900000-0000-7000-8000-000000000004', NULL, 'analyst', 'Analyst', 'organization', true),
  ('01900000-0000-7000-8000-000000000005', NULL, 'member', 'Member', 'organization', true),
  ('01900000-0000-7000-8000-000000000006', NULL, 'team_lead', 'Team lead', 'team', true),
  ('01900000-0000-7000-8000-000000000007', NULL, 'team_member', 'Team member', 'team', true),
  ('01900000-0000-7000-8000-000000000008', NULL, 'workspace_admin', 'Workspace administrator', 'workspace', true),
  ('01900000-0000-7000-8000-000000000009', NULL, 'editor', 'Editor', 'workspace', true),
  ('01900000-0000-7000-8000-000000000010', NULL, 'contributor', 'Contributor', 'workspace', true),
  ('01900000-0000-7000-8000-000000000011', NULL, 'approver', 'Approver', 'workspace', true),
  ('01900000-0000-7000-8000-000000000012', NULL, 'viewer', 'Viewer', 'workspace', true),
  ('01900000-0000-7000-8000-000000000013', NULL, 'client_guest', 'Client guest', 'workspace', true);
