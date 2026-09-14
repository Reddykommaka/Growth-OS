-- role_permissions
--
-- WHO MAY READ:  any member of the organization — plus the SYSTEM rows shared by every
--                tenant, which are the rows with organization_id IS NULL.
-- WHO MAY WRITE: a member of the organization, into that organization only. Never a system
--                row.
--
-- ASYMMETRIC, IN THE DANGEROUS DIRECTION — written the safe way. USING is BROADER than the
-- write rule. This is precisely the shape described in 06-identity-and-access.md §4.
--
-- If WITH CHECK were omitted here, PostgreSQL would reuse the broad USING as the write
-- predicate, and `organization_id IS NULL` would be a satisfiable write. A tenant could then
-- insert a permission on a role with organization_id NULL — attaching a permission to a SYSTEM ROLE, changing what every other tenant's built-in roles can do. That is a privilege-escalation
-- path across every tenant boundary in the system, from one missing clause.
--
-- The explicit narrow WITH CHECK closes it. The generic cross-tenant probe CANNOT catch
-- this class on its own (only the policy author knows NULL is the value satisfying the
-- broad predicate), so a hand-written probe asserts it directly — see the roles describe
-- block in packages/testing/src/pg/tenancy.test.ts.
--
-- Why system rows are shared rather than copied per organization: copying nine system roles
-- into every new tenant means a permission added to a system role later never reaches any
-- tenant that already exists.
--
-- canonical-using:      ((organization_id IS NULL) OR (organization_id = app_current_organization_id()))
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON role_permissions
  USING      (organization_id IS NULL OR organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
