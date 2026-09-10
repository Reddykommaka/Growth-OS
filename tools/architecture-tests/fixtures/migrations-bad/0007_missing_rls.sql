-- VIOLATION: tenant-scoped table with no RLS at all.
CREATE TABLE bad_tenant_table (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  name            text NOT NULL
);
