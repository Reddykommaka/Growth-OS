-- outbox_events — THE EVENT SPINE
--
-- WHO MAY READ:  a session inside the owning organization, AND — for an event tagged with a
--                workspace — either that workspace is in the actor's resolved accessible set,
--                or the actor holds organization-wide workspace access. Same shape as
--                `audit_events`, for the same reason: an event names a workspace, so reading
--                events freely would enumerate workspaces.
-- WHO MAY WRITE: INSERT only, inside the acting organization. No UPDATE and no DELETE, and
--                the relay's columns are unreachable from a request at all.
--
-- THE READ RULE IS NARROWER THAN THE WRITE RULE, DELIBERATELY — and the reasoning is the same
-- as audit_events'. Requiring accessible-set membership on INSERT would make the EVENT the
-- thing that fails when a service acts slightly outside its resolved set, turning a boundary
-- slip into a lost side effect in the very statement that was supposed to cause it. An
-- automation that silently never fires is a worse outcome than an event visible to one
-- session too many, and the event's own authorization was already decided by the action that
-- emitted it.
--
-- `published_at` AND `attempts` ARE NOT THE TENANT'S STATE. They are the relay's. A session
-- that could UPDATE this table could mark its own event published without it ever being
-- delivered — cancelling its own side effects with a statement RLS would happily allow,
-- because the row passes the tenant predicate. A policy cannot express this: RLS filters
-- rows, and what is needed is for the statement to be refused. Migration 0015 therefore
-- REVOKEs UPDATE and DELETE from the application role, exactly as 0011 does for audit_events,
-- because migration 0001's ALTER DEFAULT PRIVILEGES would otherwise have granted both.
--
-- THE RELAY IS NOT A TENANT. It reads across every organization by design, so it cannot run
-- under this predicate at all. It runs as `growth_os_relay` — BYPASSRLS, but granted exactly
-- four tables and holding no CREATE on the schema. Neither existing role would do:
-- `growth_os_app` would need BYPASSRLS, which would dissolve the isolation model to solve a
-- background-job problem, and `growth_os_migrator` owns every table and holds DDL rights that
-- a long-lived worker process has no business carrying.
--
-- NOT PARTITIONED, unlike the other high-volume tables. This is a queue: rows are written,
-- published and pruned, so its steady-state size is a function of relay lag rather than of
-- tenant age. Partitioning it would put a routing decision on the hottest write path in the
-- system and force the relay's `FOR UPDATE SKIP LOCKED` scan across every partition.
--
-- canonical-using:      ((organization_id = app_current_organization_id()) AND ((workspace_id IS NULL) OR app_workspace_scope_is_all() OR (workspace_id = ANY (app_current_workspace_ids()))))
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON outbox_events
  USING (
    organization_id = app_current_organization_id()
    AND (
      workspace_id IS NULL
      OR app_workspace_scope_is_all()
      OR workspace_id = ANY (app_current_workspace_ids())
    )
  )
  WITH CHECK (organization_id = app_current_organization_id());
