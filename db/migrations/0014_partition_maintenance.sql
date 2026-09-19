-- 0014 — The partition maintenance registry.
--
-- 05-data-architecture.md §7 says "a scheduled job pre-creates partitions 3 months ahead
-- and detaches/archives those past retention". The functions to do both have existed since
-- 0002, and 0011/0013 added hardening wrappers for the two tables that have them. Nothing
-- called any of it on a schedule, which made a missed maintenance window a silent cliff:
-- a partitioned table with no partition covering now() REJECTS the insert, so for
-- audit_events that is every audited write in the product failing at once.
--
-- This migration closes the pre-creation half. Two things were needed and neither is a
-- scheduler:
--
--   1. A registry, so the job does not carry a hardcoded list of tables that a future
--      migration can silently fail to update. `unregistered_partitioned_tables()` makes
--      omission a loud failure instead.
--
--   2. A single entry point that dispatches through each table's OWN ensure function.
--      Calling ensure_month_partitions() generically would be a security defect, not a
--      shortcut: partitions of audit_events and usage_records are separate tables that
--      inherit the application's default privileges and none of the parent's policies
--      (see 0011). Only ensure_audit_partitions / ensure_usage_partitions create and
--      harden in one step.
--
-- Retention (detach → Parquet → drop) is deliberately NOT executed here. See
-- ADR-0021: it is blocked on object storage export, not on scheduling, and a job that
-- detached without archiving would be a one-line route to unrecoverable data loss. The
-- POLICY is recorded now, in `retention_months`, so the archival job reads it rather than
-- re-deriving it from a prose table.

CREATE TABLE partition_maintenance (
  parent_table     text PRIMARY KEY,
  -- The function the maintenance job calls. Stored as a name, not as SQL: the job executes
  -- it as `SELECT <name>($1)`, so a registry row can never smuggle in a statement.
  ensure_function  text NOT NULL,
  -- Months of partitions to keep ahead of now(). Per-table because the tables do not share
  -- a write profile: a table written on every request needs more runway than one written
  -- by a monthly rollup.
  months_ahead     integer NOT NULL DEFAULT 3 CHECK (months_ahead BETWEEN 1 AND 24),
  -- Hot retention from 05 §10. NULL means "not yet decided" and is a live question, not a
  -- default: `retention_note` must then say who decides it.
  retention_months integer CHECK (retention_months IS NULL OR retention_months > 0),
  -- Whether a detached partition must reach object storage before it may be dropped.
  -- 05 §10 requires this for every class we partition, so the default is the safe one.
  archive_before_drop boolean NOT NULL DEFAULT true,
  retention_note   text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partition_maintenance_ensure_function_is_bare_name
    CHECK (ensure_function ~ '^[a-z_][a-z0-9_]*$')
);

COMMENT ON TABLE partition_maintenance IS
  'Registry of RANGE-partitioned tables and the function that pre-creates their partitions. '
  'Read by the deploy-time maintenance job; see ADR-0021.';

-- Untenanted operational configuration, like the migration ledger. The application role
-- gets no access at all: partition management is scheduled operational work and must never
-- be reachable from a request (the same reasoning as the 0002 grants).
REVOKE ALL ON partition_maintenance FROM PUBLIC;
REVOKE ALL ON partition_maintenance FROM growth_os_app;

-- ---------------------------------------------------------------------------------------
-- Registrations
-- ---------------------------------------------------------------------------------------
INSERT INTO partition_maintenance
  (parent_table, ensure_function, months_ahead, retention_months, archive_before_drop, retention_note)
VALUES
  ('audit_events', 'ensure_audit_partitions', 3, 24, true,
   '05 §10: 2 years hot, 7 years archived. Hash-chained, so an archived partition must be '
   'verifiable after export — the chain is continuous across a detach and the export must '
   'carry previous_hash. Never drop without the archive.'),
  ('usage_records', 'ensure_usage_partitions', 3, NULL, true,
   'Hot retention is undecided. usage_records is the evidence behind a metered invoice, so '
   'its clock is the Financial class (7 years) rather than the Operational one (90 days) if '
   'it is ever billed from directly. The billing work item decides and sets this; until it '
   'does, nothing ages this table out.');

-- ---------------------------------------------------------------------------------------
-- The entry points
-- ---------------------------------------------------------------------------------------

-- Partitioned parents with no registry row. A non-empty result fails the maintenance job.
--
-- This is the guard that makes the registry worth having: adding a partitioned fact table
-- without registering it is otherwise invisible until the month its pre-created partitions
-- run out, which is months after the migration that caused it.
CREATE OR REPLACE FUNCTION unregistered_partitioned_tables()
RETURNS SETOF text
LANGUAGE sql STABLE AS $$
  SELECT c.relname::text
    FROM pg_class c
    JOIN pg_partitioned_table p ON p.partrelid = c.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (
       SELECT 1 FROM partition_maintenance m WHERE m.parent_table = c.relname
     )
   ORDER BY 1
$$;

-- Runs every registered table's own ensure function. Returns one row per table with the
-- partitions that exist for it afterwards, so the job logs what it actually did rather
-- than reporting success from an exit code alone.
CREATE OR REPLACE FUNCTION ensure_registered_partitions()
RETURNS TABLE (parent_table text, partitions text[])
LANGUAGE plpgsql AS $$
DECLARE
  registration record;
  created      text[];
BEGIN
  FOR registration IN
    SELECT m.parent_table, m.ensure_function, m.months_ahead
      FROM partition_maintenance m
     ORDER BY m.parent_table
  LOOP
    -- The parent must still exist. A registry row for a dropped table would otherwise
    -- abort the whole job, taking the tables that ARE fine down with it.
    IF to_regclass(format('public.%I', registration.parent_table)) IS NULL THEN
      RAISE EXCEPTION 'partition_maintenance registers %, which does not exist',
        registration.parent_table;
    END IF;

    EXECUTE format('SELECT array_agg(f) FROM %I($1) AS f', registration.ensure_function)
      INTO created
      USING registration.months_ahead;

    parent_table := registration.parent_table;
    partitions   := coalesce(created, ARRAY[]::text[]);
    RETURN NEXT;
  END LOOP;
END
$$;

-- Months of runway before the newest partition of each registered table stops covering
-- now(). The readiness check reads this: a number that trends towards zero is the only
-- warning available before writes to the table begin failing outright.
CREATE OR REPLACE FUNCTION partition_headroom()
RETURNS TABLE (parent_table text, months_ahead integer)
LANGUAGE sql STABLE AS $$
  SELECT m.parent_table,
         -- Whole months between the end of the current month and the newest upper bound.
         -- NULL upper bound (no partitions at all) reports -1: already past the cliff,
         -- which must be distinguishable from "zero months of spare runway".
         coalesce(
           max(
             (date_part('year',  bound.upper_bound) - date_part('year',  now()))::integer * 12
             + (date_part('month', bound.upper_bound) - date_part('month', now()))::integer
           ) - 1,
           -1
         )::integer
    FROM partition_maintenance m
    LEFT JOIN LATERAL (
      SELECT ((regexp_match(
                pg_get_expr(child.relpartbound, child.oid),
                $re$TO \('([^']+)'\)$re$
              ))[1])::timestamptz AS upper_bound
        FROM pg_class parent
        JOIN pg_inherits i     ON i.inhparent = parent.oid
        JOIN pg_class   child  ON child.oid = i.inhrelid
       WHERE parent.relname = m.parent_table
         AND child.relispartition
    ) AS bound ON true
   GROUP BY m.parent_table
   ORDER BY 1
$$;

REVOKE EXECUTE ON FUNCTION unregistered_partitioned_tables()  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ensure_registered_partitions()     FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION unregistered_partitioned_tables()  TO growth_os_migrator;
GRANT  EXECUTE ON FUNCTION ensure_registered_partitions()     TO growth_os_migrator;

-- partition_headroom is the exception: the application role MAY call it, because the
-- readiness probe runs as the application. It is read-only, reads no tenant data and
-- returns two integers about the shape of the schema, so exposing it costs nothing and
-- withholding it would mean the probe needed migrator credentials in every replica.
REVOKE EXECUTE ON FUNCTION partition_headroom() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION partition_headroom() TO growth_os_migrator;
GRANT  EXECUTE ON FUNCTION partition_headroom() TO growth_os_app;
GRANT  SELECT  ON partition_maintenance TO growth_os_app;

-- Pre-create now, so the registry is correct the moment it exists rather than at the first
-- scheduled run.
SELECT * FROM ensure_registered_partitions();
