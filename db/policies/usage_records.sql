-- usage_records — WHAT WAS CONSUMED, AND BY WHOM
--
-- WHO MAY READ:  a session inside the owning organization, subject to the same workspace
--                clause as the other entitlement tables.
-- WHO MAY WRITE: INSERT only, inside the acting organization. There is no UPDATE and no
--                DELETE grant at all.
--
-- APPEND-ONLY IS A GRANT, NOT A POLICY — the same mechanism as `audit_events`. Migration
-- 0001's ALTER DEFAULT PRIVILEGES hands the application full DML on every table the migrator
-- creates, so migration 0013 revokes UPDATE and DELETE explicitly. RLS filters rows; the
-- guarantee needed here is that the statement is refused outright. A consumption record that
-- can be edited is not a record, and this table is the evidence behind a metered invoice.
--
-- WRITTEN IN THE SAME TRANSACTION AS THE COUNTER. The conditional UPDATE on
-- `entitlement_usage` and the INSERT here commit together, so the enforcement total and the
-- evidence for it can never disagree. Staging the record through the outbox would mean a
-- counter that moved and a record that had not arrived yet — and the gap would be visible to
-- exactly the query a billing dispute asks.
--
-- PARTITIONS ARE TABLES. RANGE-partitioned monthly on `recorded_at` (05 §7). A partition is
-- a table in its own right, governed by its own policies and reached by the default
-- privileges, so `harden_usage_partition` enables and forces row security, installs the same
-- policy and revokes the application's DML at creation — and `ensure_usage_partitions` is
-- what the maintenance job calls, so a partition can never exist unhardened. Registered in
-- `partition_maintenance` (migration 0014) so the job cannot forget it; ADR-0021 records why
-- retention here is still undecided rather than defaulted.
--
-- canonical-using:      ((organization_id = app_current_organization_id()) AND ((workspace_id IS NULL) OR app_workspace_scope_is_all() OR (workspace_id = ANY (app_current_workspace_ids()))))
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON usage_records
  USING (
    organization_id = app_current_organization_id()
    AND (
      workspace_id IS NULL
      OR app_workspace_scope_is_all()
      OR workspace_id = ANY (app_current_workspace_ids())
    )
  )
  WITH CHECK (organization_id = app_current_organization_id());
