-- 0011 — The audit log: append-only, hash-chained, partitioned.
--
-- 05-data-architecture.md §9: every mutation through an application service writes an
-- `audit_events` row IN THE SAME TRANSACTION as the change, rows are hash-chained per
-- organization so silent tampering is detectable, and the table is append-only — the
-- application role holds INSERT and SELECT and no UPDATE or DELETE at all, enforced by
-- PostgreSQL privileges rather than by convention.
--
-- WHY THE GRANTS NEED SAYING OUT LOUD. Migration 0001 sets ALTER DEFAULT PRIVILEGES granting
-- SELECT, INSERT, UPDATE, DELETE on tables the migrator creates. That default applies here
-- too, so this migration must REVOKE the two that must not exist. Its own comment says so:
-- "append-only tables such as audit_events withhold UPDATE and DELETE from the application
-- role in their own migration". This is that migration.

-- ---------------------------------------------------------------------------------------
-- audit_chain_heads — the per-organization chain tip
-- ---------------------------------------------------------------------------------------
-- The chain needs the previous event's hash. Finding it by scanning audit_events would mean
-- an ORDER BY across every monthly partition on the hot write path, and would still race:
-- two concurrent writers would both read the same tip and fork the chain.
--
-- A single narrow row per organization, taken with SELECT ... FOR UPDATE, gives both the tip
-- and the serialization in one step. Contention is per-organization and nothing else — two
-- tenants writing at the same moment never touch the same row, which is what keeps the chain
-- off the critical path for the system as a whole.
--
-- This table is MUTABLE by design; it is a pointer, not the record. Tampering with it does
-- not rewrite history: audit_events rows cannot be modified at all, and a head that no
-- longer matches the last event makes the NEXT event chain from a value verification will
-- reject. The break is detectable, which is the property being bought.
CREATE TABLE audit_chain_heads (
  -- No FK, for the same reason audit_events has none: the chain must outlive the tenant it
  -- describes, and one reserved id (the platform chain) names no organization at all.
  organization_id uuid        PRIMARY KEY,
  last_sequence   bigint      NOT NULL,
  last_hash       bytea       NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_chain_heads_sequence_positive CHECK (last_sequence >= 0)
);

ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_chain_heads FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_chain_heads
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

-- The head advances, so UPDATE is required. DELETE is not: removing a head would let the
-- next event restart the chain at sequence 1 with a fresh genesis, which is precisely the
-- erasure this design exists to prevent.
REVOKE ALL ON audit_chain_heads FROM growth_os_app;
GRANT SELECT, INSERT, UPDATE ON audit_chain_heads TO growth_os_app;

-- ---------------------------------------------------------------------------------------
-- The platform chain
-- ---------------------------------------------------------------------------------------
-- Some security events genuinely precede any tenant: a failed sign-in against an address
-- that belongs to nobody, a registration, a password reset requested from a login page. They
-- must be recorded — they are the events an intrusion looks like — but there is no
-- organization to chain them to.
--
-- They go to a reserved organization id instead of being dropped, or the alternative is an
-- audit log that is silent about exactly the period an attacker is most active in. The
-- consequence is deliberate and worth stating: because RLS compares organization_id to the
-- session's tenant, NO tenant session can read the platform chain. It is reachable only by
-- an operator path that scopes itself to this id, which is correct — one tenant must not be
-- able to see that an address it does not own failed to sign in.
--
-- The id is a valid uuid (v7 layout, reserved range) so it passes the same validation every
-- other tenant id does, rather than being a special case in the application.
COMMENT ON TABLE audit_chain_heads IS
  'Per-organization audit chain tip. The reserved id 01900000-0000-7000-8000-0000000000fe '
  'is the platform chain, for security events that precede any tenant.';

-- ---------------------------------------------------------------------------------------
-- audit_events
-- ---------------------------------------------------------------------------------------
-- No foreign keys to the subjects it describes (05 §"Audit / outbox | No FK to subjects"):
-- an audit record must survive the deletion of the user, key or workspace it is about. The
-- organization reference is likewise absent — closing a tenant retains its audit events (05
-- §"Deleting an organization").
CREATE TABLE audit_events (
  id                   uuid        NOT NULL,
  organization_id      uuid        NOT NULL,
  -- Gapless and monotonic PER ORGANIZATION. This, not occurred_at, is the ordering: two
  -- events in the same transaction can share a timestamp, and a clock can go backwards.
  sequence             bigint      NOT NULL,
  occurred_at          timestamptz NOT NULL,

  -- WHO. actor_type says which of the two id columns is meaningful; 'system' has neither.
  actor_type           text        NOT NULL
                                   CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_user_id        uuid        NULL,
  actor_api_key_id     uuid        NULL,
  -- The ORIGINAL actor behind an impersonated session. Never overwritten by the effective
  -- actor: an impersonating support engineer must remain identifiable afterwards
  -- (06-identity-and-access.md §2). NULL means the action was not impersonated.
  impersonator_user_id uuid        NULL,

  -- WHAT.
  action               text        NOT NULL,
  resource_type        text        NOT NULL,
  resource_id          text        NOT NULL,
  -- Present when the action concerns one workspace. It is what lets the read policy apply
  -- the same workspace boundary every other workspace-scoped table applies.
  workspace_id         uuid        NULL,
  result               text        NOT NULL
                                   CHECK (result IN ('succeeded', 'denied', 'failed')),

  -- CONTEXT. Redaction happens in the application before the value arrives; the column is
  -- the last place to look for a secret, not the first line of defence.
  ip                   inet        NULL,
  user_agent           text        NULL,
  request_id           text        NULL,
  metadata             jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- THE CHAIN. prev_hash is NOT NULL: the first event of an organization chains from a
  -- genesis value derived from the organization id, so a chain can never be spliced onto
  -- another tenant's and there is no nullable case for verification to special-case.
  prev_hash            bytea       NOT NULL,
  hash                 bytea       NOT NULL,

  -- The partition key must be part of every unique constraint, so identity is (id,
  -- occurred_at) rather than id alone.
  PRIMARY KEY (id, occurred_at),
  CONSTRAINT audit_events_sequence_positive CHECK (sequence > 0),
  CONSTRAINT audit_events_hash_length  CHECK (octet_length(hash) = 32),
  CONSTRAINT audit_events_prev_length  CHECK (octet_length(prev_hash) = 32),
  -- A user actor names a user, a key actor names a key. Without this an event could claim
  -- 'user' and carry no user id, which reads as "someone did this" and identifies nobody.
  CONSTRAINT audit_events_actor_identified CHECK (
    (actor_type = 'user'    AND actor_user_id    IS NOT NULL AND actor_api_key_id IS NULL) OR
    (actor_type = 'api_key' AND actor_api_key_id IS NOT NULL AND actor_user_id    IS NULL) OR
    (actor_type = 'system'  AND actor_user_id    IS NULL     AND actor_api_key_id IS NULL)
  )
) PARTITION BY RANGE (occurred_at);

-- Ordering and gap detection: verification walks an organization's events by sequence and a
-- missing number is a deletion. UNIQUE also stops two writers claiming the same position.
CREATE UNIQUE INDEX audit_events_org_sequence_key
  ON audit_events (organization_id, sequence, occurred_at);

-- The listing query: one organization's events, newest first, paginated.
CREATE INDEX audit_events_org_time_idx
  ON audit_events (organization_id, occurred_at DESC, sequence DESC);

-- Filtered by workspace — the per-client view an agency looks at.
CREATE INDEX audit_events_org_workspace_time_idx
  ON audit_events (organization_id, workspace_id, occurred_at DESC)
  WHERE workspace_id IS NOT NULL;

-- Filtered by actor — "what did this person do", the first question of an investigation.
CREATE INDEX audit_events_org_actor_time_idx
  ON audit_events (organization_id, actor_user_id, occurred_at DESC)
  WHERE actor_user_id IS NOT NULL;

-- Filtered by subject — "everything that happened to this API key / invitation / member".
CREATE INDEX audit_events_org_resource_time_idx
  ON audit_events (organization_id, resource_type, resource_id, occurred_at DESC);

-- Filtered by action — "every failed sign-in", "every role change".
CREATE INDEX audit_events_org_action_time_idx
  ON audit_events (organization_id, action, occurred_at DESC);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

-- The read boundary is the tenant AND, for an event tagged with a workspace, the accessible
-- workspace set — the same predicate `workspaces` carries since 0007. Without the second
-- clause a client_guest holding audit_log:read in their own organization would read events
-- about workspaces they cannot otherwise see. Organization-level events (workspace_id NULL)
-- are readable by anyone the permission layer admits, which is what audit_log:read being an
-- ORGANIZATION-scoped permission already restricts to organization-scoped roles.
CREATE POLICY tenant_isolation ON audit_events
  USING (
    organization_id = app_current_organization_id()
    AND (
      workspace_id IS NULL
      OR app_workspace_scope_is_all()
      OR workspace_id = ANY (app_current_workspace_ids())
    )
  )
  -- Writes are not narrowed by the workspace set: a service records an event about the
  -- workspace it is acting on, and that is already authorised by the action itself. Making
  -- the audit write the thing that fails would turn a boundary slip into a lost security
  -- record — the one outcome this table exists to prevent.
  WITH CHECK (organization_id = app_current_organization_id());

-- APPEND-ONLY, structurally. The default privileges from 0001 would otherwise hand the
-- application UPDATE and DELETE here.
REVOKE ALL ON audit_events FROM growth_os_app;
GRANT SELECT, INSERT ON audit_events TO growth_os_app;

-- ---------------------------------------------------------------------------------------
-- Partition hardening
-- ---------------------------------------------------------------------------------------
-- A partition is a table in its own right. Row security enabled on the parent governs
-- access THROUGH the parent; a query naming the partition directly is governed by the
-- partition's own policies, and ALTER DEFAULT PRIVILEGES from 0001 grants the application
-- full DML on it the moment it is created. A monthly partition created by a scheduled job
-- would therefore be a readable, writable, unpoliced copy of the audit log.
--
-- Every partition is hardened at creation. An integration test asserts that naming a
-- partition directly is refused, so this is verified rather than assumed.
CREATE OR REPLACE FUNCTION harden_audit_partition(partition_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', partition_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', partition_name);

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

-- Creates and hardens the audit partitions for the coming months. The scheduled job calls
-- this rather than ensure_month_partitions() directly, so a partition can never exist
-- unhardened — not even for the moment between the two statements.
CREATE OR REPLACE FUNCTION ensure_audit_partitions(months_ahead integer DEFAULT 3)
RETURNS SETOF text
LANGUAGE plpgsql AS $$
DECLARE
  created text;
BEGIN
  FOR created IN SELECT * FROM ensure_month_partitions('audit_events', months_ahead) LOOP
    PERFORM harden_audit_partition(created);
    RETURN NEXT created;
  END LOOP;
END
$$;

REVOKE EXECUTE ON FUNCTION harden_audit_partition(text)     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ensure_audit_partitions(integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION harden_audit_partition(text)     TO growth_os_migrator;
GRANT  EXECUTE ON FUNCTION ensure_audit_partitions(integer) TO growth_os_migrator;

-- The partitions that must exist for writes to succeed right now. A partitioned table with
-- no partition covering now() rejects the insert outright, and for this table that means a
-- failed security record rather than a dropped metric.
SELECT ensure_audit_partitions(3);
