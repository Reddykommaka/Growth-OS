-- 0013 — Plans, entitlements and metered usage.
--
-- 05-data-architecture.md §"Billing & entitlements". Five concepts that are routinely
-- conflated and are kept apart here because conflating them is what makes an entitlement
-- system impossible to change later:
--
--   PERMISSION  — may this ACTOR perform this operation? (roles, migration 0005)
--   ENTITLEMENT — does this ORGANIZATION have this capability at all? (here)
--   LIMIT       — how much of it? (here)
--   USAGE       — how much has been consumed? (here)
--   BILLING     — which commercial agreement produced the entitlement? (subscriptions, here;
--                 invoices, payment methods and the provider relationship are billing's, and
--                 land with that module)
--
-- A protected operation must pass the permission check AND the entitlement check. Neither
-- implies the other: an owner with every permission in an organization on a plan without
-- `ai.agents` cannot run one, and a plan that includes it does not let a `viewer` start one.

-- ---------------------------------------------------------------------------------------
-- plans and their features
-- ---------------------------------------------------------------------------------------
-- UNTENANTED. A plan is catalogue data shared by every tenant, like the system roles seeded
-- in 0006 — not a per-organization row. RLS would be meaningless on it and the read is
-- global by design.
CREATE TABLE plans (
  id          uuid        PRIMARY KEY,
  key         text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  -- 'active' plans may be subscribed to; 'grandfathered' may not be newly subscribed but
  -- must keep resolving, because organizations are still on them.
  status      text        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'grandfathered', 'retired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_features (
  id             uuid    PRIMARY KEY,
  plan_id        uuid    NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
  -- A key from the capability catalogue in @growth-os/entitlements. Not a foreign key: the
  -- catalogue is CODE, and a database that could disagree with it about which capabilities
  -- exist is a second source of truth. A structural test asserts every row names a key the
  -- catalogue declares.
  capability_key text    NOT NULL,
  enabled        boolean NOT NULL DEFAULT true,
  -- NULL means "no numeric limit applies to this capability" (a boolean feature).
  -- is_unlimited distinguishes "explicitly unlimited" from "not yet decided", which a NULL
  -- alone cannot, and which is the difference between granting everything and granting
  -- nothing the first time a limit is added to an existing capability.
  limit_value    bigint  NULL CHECK (limit_value IS NULL OR limit_value >= 0),
  is_unlimited   boolean NOT NULL DEFAULT false,
  CONSTRAINT plan_features_limit_shape CHECK (NOT (is_unlimited AND limit_value IS NOT NULL)),
  UNIQUE (plan_id, capability_key)
);

CREATE INDEX plan_features_plan_idx ON plan_features (plan_id);

GRANT SELECT ON plans, plan_features TO growth_os_app;

-- ---------------------------------------------------------------------------------------
-- subscriptions — the commercial fact entitlements read
-- ---------------------------------------------------------------------------------------
-- The table is created here because entitlement resolution cannot work without it, but its
-- LIFECYCLE belongs to the billing module: invoices, payment methods, dunning and the
-- provider relationship land with that module and are not modelled here. `provider` and
-- `provider_subscription_id` are deliberately generic — a column named `stripe_...` would
-- put one vendor in the schema, and ADR-0013's reasoning about model providers applies just
-- as well to payment ones.
CREATE TABLE subscriptions (
  id                       uuid        PRIMARY KEY,
  organization_id          uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  plan_id                  uuid        NOT NULL REFERENCES plans (id) ON DELETE RESTRICT,
  status                   text        NOT NULL
                                       CHECK (status IN ('trialing', 'active', 'past_due',
                                                         'canceled', 'paused')),
  current_period_start     timestamptz NOT NULL,
  current_period_end       timestamptz NOT NULL,
  provider                 text        NULL,
  provider_subscription_id text        NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_period_ordered CHECK (current_period_end > current_period_start)
);

-- One live subscription per organization. A second would make "which plan applies" a
-- question with two answers, and entitlement resolution must be deterministic.
CREATE UNIQUE INDEX subscriptions_one_live_per_org
  ON subscriptions (organization_id)
  WHERE status IN ('trialing', 'active', 'past_due');

CREATE INDEX subscriptions_organization_idx ON subscriptions (organization_id);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriptions
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE ON subscriptions TO growth_os_app;

-- ---------------------------------------------------------------------------------------
-- entitlement_overrides — how an enterprise deal is honoured without inventing a plan
-- ---------------------------------------------------------------------------------------
-- A grant outside the plan, at organization or workspace scope. `workspace_id IS NULL` means
-- the whole organization.
CREATE TABLE entitlement_overrides (
  id              uuid        PRIMARY KEY,
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  workspace_id    uuid        NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  capability_key  text        NOT NULL,
  enabled         boolean     NOT NULL,
  limit_value     bigint      NULL CHECK (limit_value IS NULL OR limit_value >= 0),
  is_unlimited    boolean     NOT NULL DEFAULT false,
  -- Why this exists. An override with no stated reason is indistinguishable from a mistake
  -- six months later, and this table is where "why does this customer have that?" is
  -- answered.
  reason          text        NOT NULL,
  expires_at      timestamptz NULL,
  granted_by      uuid        NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlement_overrides_limit_shape
    CHECK (NOT (is_unlimited AND limit_value IS NOT NULL))
);

-- One override per (scope, capability). Two would reintroduce the ambiguity the precedence
-- order exists to remove. NULL workspace_id needs its own index: NULLs are distinct in a
-- plain UNIQUE, so the organization-scoped case would not be constrained at all.
CREATE UNIQUE INDEX entitlement_overrides_workspace_key
  ON entitlement_overrides (organization_id, workspace_id, capability_key)
  WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX entitlement_overrides_organization_key
  ON entitlement_overrides (organization_id, capability_key)
  WHERE workspace_id IS NULL;

ALTER TABLE entitlement_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement_overrides FORCE ROW LEVEL SECURITY;

-- The workspace clause is the same one `workspaces` carries since 0007: an override naming a
-- workspace must not be readable by a session that cannot reach that workspace, or the
-- entitlement table becomes a way to enumerate an agency's clients.
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

GRANT SELECT, INSERT, UPDATE, DELETE ON entitlement_overrides TO growth_os_app;

-- ---------------------------------------------------------------------------------------
-- entitlement_usage — the ENFORCEMENT counter
-- ---------------------------------------------------------------------------------------
-- One row per (organization, workspace, capability, period). This is what makes consumption
-- race-free: a check followed by a separate increment loses under concurrency no matter how
-- carefully the check is written, so the check IS the increment —
--
--   UPDATE ... SET used = used + $n WHERE ... AND used + $n <= $limit
--
-- — and a zero row count means the limit would have been exceeded. No advisory lock, no
-- read-then-write, no serialization beyond the single row being consumed.
CREATE TABLE entitlement_usage (
  id              uuid        PRIMARY KEY,
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  -- NULL for organization-wide meters; set for per-workspace ones (05 §"Agency billing
  -- shape": an agency's bill scales with clients served).
  workspace_id    uuid        NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  capability_key  text        NOT NULL,
  -- The billing period this counter belongs to. Resetting is not an UPDATE: a new period is
  -- a new row, so history survives and a late-arriving consumption cannot land in the wrong
  -- period.
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  used            bigint      NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlement_usage_period_ordered CHECK (period_end > period_start)
);

CREATE UNIQUE INDEX entitlement_usage_workspace_key
  ON entitlement_usage (organization_id, workspace_id, capability_key, period_start)
  WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX entitlement_usage_organization_key
  ON entitlement_usage (organization_id, capability_key, period_start)
  WHERE workspace_id IS NULL;

ALTER TABLE entitlement_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement_usage FORCE ROW LEVEL SECURITY;

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

GRANT SELECT, INSERT, UPDATE ON entitlement_usage TO growth_os_app;

-- ---------------------------------------------------------------------------------------
-- usage_records — the append-only history behind the counter
-- ---------------------------------------------------------------------------------------
-- The counter is the enforcement point; this is the record of what produced it, written in
-- the SAME transaction so the two can never disagree. A counter can be rebuilt by summing
-- its period's records, which is what makes a disputed invoice answerable.
--
-- Partitioned monthly (05 §7) because it grows without bound and retrofitting partitioning
-- onto a large live table is an outage.
CREATE TABLE usage_records (
  id              uuid        NOT NULL,
  organization_id uuid        NOT NULL,
  workspace_id    uuid        NULL,
  capability_key  text        NOT NULL,
  quantity        bigint      NOT NULL CHECK (quantity > 0),
  -- What consumed it, for attribution and for answering "who used these AI credits".
  actor_user_id   uuid        NULL,
  actor_api_key_id uuid       NULL,
  recorded_at     timestamptz NOT NULL,
  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

CREATE INDEX usage_records_org_time_idx
  ON usage_records (organization_id, capability_key, recorded_at DESC);
CREATE INDEX usage_records_workspace_time_idx
  ON usage_records (organization_id, workspace_id, recorded_at DESC)
  WHERE workspace_id IS NOT NULL;

ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records FORCE ROW LEVEL SECURITY;

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

-- Append-only, like audit_events: a consumption record that can be edited is not a record.
REVOKE ALL ON usage_records FROM growth_os_app;
GRANT SELECT, INSERT ON usage_records TO growth_os_app;

-- Partitions are tables in their own right — same reasoning as migration 0011.
CREATE OR REPLACE FUNCTION harden_usage_partition(partition_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', partition_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', partition_name);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', partition_name);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %I
       USING (organization_id = app_current_organization_id()
              AND (workspace_id IS NULL
                   OR app_workspace_scope_is_all()
                   OR workspace_id = ANY (app_current_workspace_ids())))
       WITH CHECK (organization_id = app_current_organization_id())',
    partition_name
  );
  EXECUTE format('REVOKE ALL ON %I FROM growth_os_app', partition_name);
  EXECUTE format('GRANT SELECT, INSERT ON %I TO growth_os_app', partition_name);
END
$$;

CREATE OR REPLACE FUNCTION ensure_usage_partitions(months_ahead integer DEFAULT 3)
RETURNS SETOF text
LANGUAGE plpgsql AS $$
DECLARE
  created text;
BEGIN
  FOR created IN SELECT * FROM ensure_month_partitions('usage_records', months_ahead) LOOP
    PERFORM harden_usage_partition(created);
    RETURN NEXT created;
  END LOOP;
END
$$;

REVOKE EXECUTE ON FUNCTION harden_usage_partition(text)   FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ensure_usage_partitions(integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION harden_usage_partition(text)   TO growth_os_migrator;
GRANT  EXECUTE ON FUNCTION ensure_usage_partitions(integer) TO growth_os_migrator;

SELECT ensure_usage_partitions(3);
