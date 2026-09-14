-- organizations — THE TENANT ROOT
--
-- WHO MAY READ:  a member acting inside this organization, and no one else.
-- WHO MAY WRITE: the same, subject to application authorization (owner/admin).
--
-- This table's tenant column is `id`, not `organization_id`. It is therefore the ONE table
-- that a sweep discovering tables by column name cannot find — which would leave the table
-- that DEFINES a tenant as the only one exempt from the check that every tenant table is
-- isolated. `TENANT_ROOT_TABLE` in @growth-os/testing names it explicitly so the automatic
-- sweep covers it; a test asserts the sweep returns it.
--
-- Symmetric, so the two expressions match.
--
-- canonical-using:      (id = app_current_organization_id())
-- canonical-with-check: (id = app_current_organization_id())

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON organizations
  USING      (id = app_current_organization_id())
  WITH CHECK (id = app_current_organization_id());
