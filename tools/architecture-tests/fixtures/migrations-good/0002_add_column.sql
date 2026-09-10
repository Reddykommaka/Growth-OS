-- Expand step: nullable, so it is safe against the previous application version.
ALTER TABLE good_tenant_table ADD COLUMN note text;

-- Indexes outside the initial migration are built CONCURRENTLY.
CREATE INDEX CONCURRENTLY good_tenant_table_status_idx
  ON good_tenant_table (organization_id, status) WHERE status = 'active';
