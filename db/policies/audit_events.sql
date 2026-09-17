-- audit_events — THE RECORD OF EVERYTHING ELSE
--
-- WHO MAY READ:  a member acting inside the organization the event belongs to, AND — for an
--                event tagged with a workspace — either the workspace is in that actor's
--                resolved accessible set, or the actor holds organization-wide workspace
--                access. The application additionally requires
--                `organization.audit_log:read`, which is declared ORGANIZATION-scoped, so no
--                workspace-scoped role (editor, contributor, client_guest) carries it.
-- WHO MAY WRITE: INSERT only, inside the acting organization. There is no UPDATE and no
--                DELETE grant at all.
--
-- THE READ RULE IS NARROWER THAN THE WRITE RULE, DELIBERATELY.
--
-- The workspace clause appears in USING and not in WITH CHECK. Both halves are considered:
--
--   Reading. Without the clause, a session holding audit_log:read could read events about
--   workspaces it cannot otherwise see — the same enumeration defect migration 0007 closed
--   on `workspaces`, arriving through a different table. An agency's audit log names its
--   clients; a client_guest reading it would learn the whole client list.
--
--   Writing. Requiring set membership on INSERT would make the AUDIT WRITE the thing that
--   fails when a service acts slightly outside its resolved set. That converts a boundary
--   slip into a LOST SECURITY RECORD, which is the one outcome this table exists to
--   prevent — and it would do so silently, because the failing statement is the one that
--   was supposed to leave the evidence. The event's own authorization is already decided by
--   the action being audited.
--
-- APPEND-ONLY IS A GRANT, NOT A POLICY. 05-data-architecture.md §9 requires the application
-- role to hold INSERT and SELECT and nothing else. Migration 0001's ALTER DEFAULT PRIVILEGES
-- grants UPDATE and DELETE on every table the migrator creates, so migration 0011 revokes
-- them explicitly. A policy cannot express this: RLS filters rows, and the guarantee needed
-- here is that the statement is refused outright.
--
-- PARTITIONS ARE TABLES. This table is RANGE-partitioned by month (05 §7). Row security on
-- the parent governs access THROUGH the parent; a query naming a partition directly is
-- governed by that partition's own policies, and the default privileges would grant the
-- application full DML on each new monthly partition. Every partition is therefore hardened
-- at creation by `harden_audit_partition`, and `ensure_audit_partitions` is what the
-- scheduled job calls so a partition can never exist unhardened. An integration test names a
-- partition directly and asserts it is refused.
--
-- canonical-using:      ((organization_id = app_current_organization_id()) AND ((workspace_id IS NULL) OR app_workspace_scope_is_all() OR (workspace_id = ANY (app_current_workspace_ids()))))
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_events
  USING (
    organization_id = app_current_organization_id()
    AND (
      workspace_id IS NULL
      OR app_workspace_scope_is_all()
      OR workspace_id = ANY (app_current_workspace_ids())
    )
  )
  WITH CHECK (organization_id = app_current_organization_id());
