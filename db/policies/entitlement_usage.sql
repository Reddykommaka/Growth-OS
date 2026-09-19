-- entitlement_usage — THE COUNTER A LIMIT IS ENFORCED AGAINST
--
-- WHO MAY READ:  a session inside the owning organization, subject to the same workspace
--                clause as `entitlement_overrides` — a counter is keyed by workspace, so
--                reading counters freely would enumerate workspaces.
-- WHO MAY WRITE: the same. Unlike most tables here the application genuinely needs UPDATE,
--                because consumption is settled by a conditional UPDATE (below).
--
-- THIS TABLE IS NOT THE RECORD OF CONSUMPTION. `usage_records` is. This is the enforcement
-- counter: one row per (organization, workspace, capability, period) holding a single
-- `used` total. The two are separate because they answer different questions and have
-- different lifetimes — the counter resets each period and must be cheap to check inside
-- the gated transaction, while the record is append-only evidence kept for as long as the
-- retention policy says (see db/policies/usage_records.sql).
--
-- CONSUMPTION IS ONE STATEMENT, AND THAT IS THE WHOLE POINT.
--
--     UPDATE entitlement_usage SET used = used + $n
--      WHERE ... AND ($limit IS NULL OR used + $n <= $limit)
--
-- The limit is a predicate on the same UPDATE that increments. The obvious alternative —
-- SELECT the counter, compare it to the limit, then UPDATE — is a check-then-act race: two
-- concurrent consumers both read `used = 9` against a limit of 10 and both proceed, and the
-- customer gets 11. An integration test runs twenty concurrent consumers against a limit of
-- ten and asserts exactly ten succeed; removing the predicate from the UPDATE fails it.
--
-- ZERO ROWS UPDATED IS THE DENIAL. There is no second read to decide the outcome, so there
-- is no window between deciding and acting.
--
-- canonical-using:      ((organization_id = app_current_organization_id()) AND ((workspace_id IS NULL) OR app_workspace_scope_is_all() OR (workspace_id = ANY (app_current_workspace_ids()))))
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE entitlement_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement_usage FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON entitlement_usage
  USING (
    organization_id = app_current_organization_id()
    AND (
      workspace_id IS NULL
      OR app_workspace_scope_is_all()
      OR workspace_id = ANY (app_current_workspace_ids())
    )
  )
  WITH CHECK (organization_id = app_current_organization_id());
