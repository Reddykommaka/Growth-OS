-- Positive control: a migration that creates a table and indexes it in the same file.
-- Not the initial migration, so the old filename-pinned rule would have rejected this —
-- yet it is the correct and only possible shape, because the runner wraps each file in a
-- transaction and CONCURRENTLY cannot run inside one.
CREATE TABLE fresh_tenant_table (
  id              uuid        PRIMARY KEY,
  organization_id uuid        NOT NULL,
  name            text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fresh_tenant_table_org_created_idx
  ON fresh_tenant_table (organization_id, created_at DESC);

ALTER TABLE fresh_tenant_table ENABLE ROW LEVEL SECURITY;
ALTER TABLE fresh_tenant_table FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON fresh_tenant_table
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
