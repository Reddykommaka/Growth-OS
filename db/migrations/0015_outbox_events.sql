-- 0015 — The transactional event spine.
--
-- ADR-0007 and 08-automation-architecture.md §2. A domain write and its side effects must not
-- be able to disagree. Writing to Postgres and publishing to Redis are two systems: publish
-- before commit and you announce a change that never happened; publish after commit and a
-- crash loses the event. The outbox removes the choice — the event is written in the SAME
-- transaction as the state change, and a relay publishes it afterwards.
--
-- WHY THIS TABLE IS NOT PARTITIONED, unlike audit_events and usage_records. It is a QUEUE,
-- not a fact table: rows are written, published and then pruned. Its steady-state size is a
-- function of relay lag, not of tenant age. Monthly partitions would add a partition-routing
-- decision to the hottest write path in the system to solve a growth problem this table does
-- not have, and the relay's `ORDER BY occurred_at ... FOR UPDATE SKIP LOCKED` would have to
-- cross every partition on every poll. 05 §7 lists the partitioned tables and this is
-- deliberately not among them.

CREATE TABLE outbox_events (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No FK to organizations, for the same reason audit_events has none: an event about a
  -- tenant being deleted must survive the deletion long enough to be published.
  organization_id uuid       NOT NULL,
  -- Nullable: many events are organization-wide (a subscription changed), and forcing a
  -- workspace on them would make the column meaningless where it is set.
  workspace_id   uuid        NULL,
  /*
   * The event's identity. Name and version are separate columns rather than one
   * "social.post.published.v2" string so a consumer can subscribe to a name and handle two
   * versions, which is what makes a payload change deployable at all under rolling deploys.
   */
  event_name     text        NOT NULL,
  event_version  integer     NOT NULL DEFAULT 1,
  payload        jsonb       NOT NULL,
  /*
   * Correlation, carried not derived. A published event that cannot be traced back to the
   * request that caused it turns "why did this automation fire" into an archaeology exercise.
   */
  request_id     text        NULL,
  actor_user_id  uuid        NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz NULL,
  attempts       integer     NOT NULL DEFAULT 0,
  /*
   * The last publish failure, kept for the operator reading a stalled relay. Bounded by the
   * relay, which truncates: an unbounded error column on a queue table is how one
   * pathological payload turns into a table bloat incident.
   */
  last_error     text        NULL,
  /*
   * DEAD-LETTERING, AND WHY IT IS NOT A CHOICE.
   *
   * Per-organization ordering means a failing event blocks every later event for that
   * organization — which is correct until the failure is permanent, at which point one poison
   * payload has silently stopped a tenant's entire event stream. 08 §3 requires quarantine
   * rather than infinite retry, and for the relay that means a terminal state: the row stops
   * being claimed, the organization drains, and the row survives for a human to inspect and
   * replay. It is NOT deleted, and it is NOT marked published — a published timestamp would
   * claim a delivery that never happened.
   */
  dead_lettered_at timestamptz NULL,
  CONSTRAINT outbox_events_name_not_blank   CHECK (length(btrim(event_name)) > 0),
  CONSTRAINT outbox_events_version_positive CHECK (event_version >= 1),
  CONSTRAINT outbox_events_attempts_non_negative CHECK (attempts >= 0),
  -- A published row with no timestamp, or a timestamp before the event, is a relay bug that
  -- would otherwise be invisible until someone reconciled lag by hand.
  CONSTRAINT outbox_events_published_after_occurred
    CHECK (published_at IS NULL OR published_at >= occurred_at),
  -- The two terminal states are mutually exclusive. A row that is both published and dead
  -- would make "was this delivered" unanswerable, which is the one question the table exists
  -- to answer.
  CONSTRAINT outbox_events_one_terminal_state
    CHECK (published_at IS NULL OR dead_lettered_at IS NULL)
);

/*
 * THE RELAY'S INDEX, and the only one that matters for throughput.
 *
 * Partial on `published_at IS NULL`: the relay only ever looks at unpublished rows, and in a
 * healthy system that is a handful out of everything ever written. A full index on
 * (occurred_at) would grow forever and would still make the relay read published rows to
 * skip them. Ordered by (organization_id, occurred_at) because per-organization ordering is
 * the guarantee 08 §2 actually makes — global ordering is explicitly not offered, and a
 * single global occurred_at index would invite a consumer to depend on it.
 */
CREATE INDEX outbox_events_unpublished
  ON outbox_events (organization_id, occurred_at)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;

/*
 * The dead-letter queue, as a query. 08 §3 requires DLQ depth to be alerted on and the
 * contents to be inspectable and replayable, and all three are reads over this index.
 */
CREATE INDEX outbox_events_dead_lettered ON outbox_events (dead_lettered_at)
  WHERE dead_lettered_at IS NOT NULL;

/* Pruning published rows, and answering "was this event published". */
CREATE INDEX outbox_events_published_at ON outbox_events (published_at)
  WHERE published_at IS NOT NULL;

CREATE INDEX outbox_events_organization_id ON outbox_events (organization_id);
CREATE INDEX outbox_events_name_occurred   ON outbox_events (event_name, occurred_at);

-- ---------------------------------------------------------------------------------------
-- Tenant isolation
-- ---------------------------------------------------------------------------------------
-- The READ rule carries the workspace clause; the WRITE rule does not, for exactly the
-- reason audit_events' does not. Requiring accessible-set membership on INSERT would make the
-- EVENT the thing that fails when a service acts slightly outside its resolved set — turning
-- a boundary slip into a lost side effect, silently, in the statement that was supposed to
-- cause it. The event's own authorization is decided by the action that emitted it.
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

/*
 * THE APPLICATION MAY WRITE EVENTS AND NEVER MARK THEM PUBLISHED.
 *
 * `published_at` and `attempts` are the relay's state, not the tenant's. A request-serving
 * session that could UPDATE this table could mark its own event published without it ever
 * being delivered — an automation that silently never fires, caused by a tenant-reachable
 * statement. Column-level grants say this in the schema rather than in a review comment.
 *
 * DELETE is withheld for the same reason: pruning is the relay's job, and a tenant that can
 * delete an unpublished event can cancel its own side effects after the fact.
 */
REVOKE ALL ON outbox_events FROM growth_os_app;
GRANT SELECT, INSERT ON outbox_events TO growth_os_app;

/*
 * The relay is not a tenant.
 *
 * It reads across every organization by design — that is what a relay is — so it cannot run
 * under the tenant predicate, and it must be able to advance `published_at`. It therefore
 * gets its own role rather than borrowing either existing one:
 *
 *   growth_os_app       would need BYPASSRLS to see other tenants' rows. Granting that to
 *                       the role that serves HTTP requests would dissolve the entire
 *                       isolation model to solve a background-job problem.
 *   growth_os_migrator  has BYPASSRLS already, but it also has CREATE on the schema and owns
 *                       every table. A long-lived worker process holding DDL rights on
 *                       production is a far larger blast radius than the relay needs.
 *
 * growth_os_relay is BYPASSRLS, NOCREATEDB, NOCREATEROLE, and is granted exactly the four
 * tables it touches — nothing else in the schema is reachable from it.
 */
-- The role itself is created in 0001, which is the only migration that can: this one runs as
-- growth_os_migrator, which is NOCREATEROLE. What belongs HERE are the grants, next to the
-- table they are about — so the relay's reach is reviewable in the migration that gives it.
GRANT USAGE ON SCHEMA public TO growth_os_relay;

-- The relay claims rows, publishes them, and marks them. It never inserts an event and never
-- deletes one that is still unpublished; pruning is a separate, explicit statement below.
GRANT SELECT, UPDATE, DELETE ON outbox_events TO growth_os_relay;

-- ---------------------------------------------------------------------------------------
-- Pruning
-- ---------------------------------------------------------------------------------------
-- Published rows are deleted after a grace period rather than immediately. The grace window
-- is what makes an incident investigable: "did this event get published, and when" is the
-- first question asked when an automation did not fire, and a row deleted at publish time
-- cannot answer it.
--
-- Deletes only rows that ARE published. A function that could delete an unpublished row would
-- make silent event loss a one-argument mistake — the same reasoning as
-- detach_partitions_before never dropping.
CREATE OR REPLACE FUNCTION prune_published_outbox_events(
  older_than interval DEFAULT interval '7 days',
  batch_size integer  DEFAULT 10000
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  removed bigint;
BEGIN
  IF batch_size <= 0 THEN
    RAISE EXCEPTION 'batch_size must be positive, got %', batch_size;
  END IF;

  -- Batched rather than one unbounded DELETE: a single statement removing millions of rows
  -- holds a long transaction, bloats WAL and blocks the relay behind it.
  WITH doomed AS (
    SELECT id FROM outbox_events
      WHERE published_at IS NOT NULL
        AND published_at < now() - older_than
      ORDER BY published_at
      LIMIT batch_size
      FOR UPDATE SKIP LOCKED
  )
  DELETE FROM outbox_events o USING doomed d WHERE o.id = d.id;

  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;

REVOKE EXECUTE ON FUNCTION prune_published_outbox_events(interval, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION prune_published_outbox_events(interval, integer) TO growth_os_relay;
GRANT  EXECUTE ON FUNCTION prune_published_outbox_events(interval, integer) TO growth_os_migrator;

-- ---------------------------------------------------------------------------------------
-- Relay lag
-- ---------------------------------------------------------------------------------------
-- 08 §2: "outbox_events is monitored on lag (now() - min(occurred_at) WHERE published_at IS
-- NULL); a growing lag is a paging alert." Exposed as a function so the readiness check and
-- the metrics exporter read one definition rather than each writing the query slightly
-- differently — which is how two dashboards end up disagreeing about whether there is an
-- incident.
--
-- Readable by the application because /readyz runs as the application. It returns two
-- numbers about the shape of the queue and no tenant data, and BYPASSRLS is required to
-- count across tenants, so it is SECURITY DEFINER with a pinned search_path.
CREATE OR REPLACE FUNCTION outbox_lag()
RETURNS TABLE (pending bigint, oldest_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::bigint,
         -- NULL when nothing is pending, which a caller must distinguish from zero seconds
         -- of lag: "no backlog" and "a backlog that is keeping up" are different states.
         EXTRACT(EPOCH FROM (now() - min(occurred_at)))::double precision
    FROM outbox_events
   -- Dead-lettered rows are excluded deliberately. They are never going to be published, so
   -- counting them as lag would leave the lag alert permanently firing and therefore ignored,
   -- which is how a real backlog goes unnoticed. DLQ depth is its own alert.
   WHERE published_at IS NULL AND dead_lettered_at IS NULL
$$;

REVOKE EXECUTE ON FUNCTION outbox_lag() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION outbox_lag() TO growth_os_app;
GRANT  EXECUTE ON FUNCTION outbox_lag() TO growth_os_relay;
GRANT  EXECUTE ON FUNCTION outbox_lag() TO growth_os_migrator;

-- ---------------------------------------------------------------------------------------
-- Dead-letter depth
-- ---------------------------------------------------------------------------------------
-- Its own signal, separate from lag, because the two mean different things and want different
-- responses: lag says the relay is behind, depth says something will never be delivered
-- without a human. Folding them together would leave the combined alert permanently on.
CREATE OR REPLACE FUNCTION outbox_dead_letter_depth()
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::bigint FROM outbox_events WHERE dead_lettered_at IS NOT NULL
$$;

REVOKE EXECUTE ON FUNCTION outbox_dead_letter_depth() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION outbox_dead_letter_depth() TO growth_os_app;
GRANT  EXECUTE ON FUNCTION outbox_dead_letter_depth() TO growth_os_relay;
GRANT  EXECUTE ON FUNCTION outbox_dead_letter_depth() TO growth_os_migrator;
