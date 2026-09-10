-- contract-step: release N-1 no longer reads good_tenant_table.note, confirmed against the
-- deployed version before merging. Safe to drop.
ALTER TABLE good_tenant_table DROP COLUMN note;
