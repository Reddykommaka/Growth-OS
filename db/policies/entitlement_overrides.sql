-- entitlement_overrides — THE DELIBERATE EXCEPTION TO THE PLAN
--
-- WHO MAY READ:  a session inside the owning organization, AND — for an override scoped to a
--                workspace — either that workspace is in the actor's resolved accessible
--                set, or the actor holds organization-wide workspace access. Same shape as
--                `workspaces` and `audit_events`, for the same reason: an override names a
--                workspace, so enumerating overrides would enumerate workspaces.
-- WHO MAY WRITE: the same, gated in the application by `billing.subscription:manage`.
--
-- WHY OVERRIDES EXIST AT ALL. Without them the only way to give one customer one extra
-- capability is to invent a plan, and a catalogue that grows a plan per negotiation stops
-- being a catalogue. `reason` is NOT NULL for the same reason: an override with no recorded
-- justification is indistinguishable from a mistake six months later.
--
-- AN OVERRIDE MAY DISABLE, NOT ONLY ENABLE. The resolver gives a workspace override
-- precedence over an organization override, and either over the plan — including when the
-- override's answer is "no". A support tool that could only ever add capability could not
-- switch one off for a customer abusing it.
--
-- EXPIRY IS DATA, NOT A JOB. `expires_at` is evaluated at resolve time. An expired row still
-- exists and is still readable — which is what makes "why did this stop working" answerable
-- — but contributes nothing to a decision. Nothing needs to sweep the table for correctness.
--
-- TWO PARTIAL UNIQUE INDEXES, not one constraint: PostgreSQL treats NULLs as distinct in a
-- unique index, so a single index on (organization_id, workspace_id, capability_key) would
-- permit unlimited duplicate organization-level overrides for the same capability. The
-- resolver would then have to pick one, silently.
--
-- canonical-using:      ((organization_id = app_current_organization_id()) AND ((workspace_id IS NULL) OR app_workspace_scope_is_all() OR (workspace_id = ANY (app_current_workspace_ids()))))
-- canonical-with-check: (organization_id = app_current_organization_id())

ALTER TABLE entitlement_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement_overrides FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON entitlement_overrides
  USING (
    organization_id = app_current_organization_id()
    AND (
      workspace_id IS NULL
      OR app_workspace_scope_is_all()
      OR workspace_id = ANY (app_current_workspace_ids())
    )
  )
  WITH CHECK (organization_id = app_current_organization_id());
