-- VIOLATION: RLS enabled and forced, but the policy has no WITH CHECK, so a tenant can
-- INSERT rows belonging to another organization even though it cannot read them.
CREATE TABLE half_secured (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL
);
ALTER TABLE half_secured ENABLE ROW LEVEL SECURITY;
ALTER TABLE half_secured FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON half_secured
  USING (organization_id = app_current_organization_id());
