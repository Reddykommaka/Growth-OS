-- Positive control: the same constructs done correctly. The lint must stay silent here,
-- otherwise it is noise rather than a gate.
CREATE TABLE parents (
  id uuid PRIMARY KEY
);

CREATE TABLE good_tenant_table (
  id              uuid        PRIMARY KEY,
  organization_id uuid        NOT NULL,
  parent_id       uuid        NOT NULL REFERENCES parents (id),
  -- Money: integer minor units + ISO-4217 code (ADR-0012).
  total_minor     bigint      NOT NULL,
  currency        char(3)     NOT NULL,
  commission_bps  integer     NOT NULL DEFAULT 0,
  -- Status as text + CHECK rather than a native enum.
  status          text        NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft', 'active', 'archived')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Every FK gets a covering index; PostgreSQL creates none.
CREATE INDEX good_tenant_table_parent_id_idx ON good_tenant_table (parent_id);
CREATE INDEX good_tenant_table_org_created_idx ON good_tenant_table (organization_id, created_at DESC);

ALTER TABLE good_tenant_table ENABLE ROW LEVEL SECURITY;
ALTER TABLE good_tenant_table FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON good_tenant_table
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
