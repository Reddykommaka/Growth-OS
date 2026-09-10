-- 0002 — Partition management helpers.
--
-- 05-data-architecture.md §7: every unbounded-growth fact table is RANGE-partitioned by
-- month from day one. Retrofitting partitioning onto a large live table is an outage, so
-- the machinery exists before the first fact table does.
--
-- A scheduled job calls ensure_month_partitions() to pre-create partitions ahead of need,
-- and detach_partitions_before() to age data out per the retention policy (§10).

-- Creates one monthly partition if it does not already exist.
-- Idempotent: safe to call repeatedly from a scheduled job.
CREATE OR REPLACE FUNCTION create_month_partition(
  parent_table text,
  month_start   date
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  partition_name text;
  range_start    date := date_trunc('month', month_start)::date;
  range_end      date := (date_trunc('month', month_start) + interval '1 month')::date;
BEGIN
  partition_name := format('%s_%s', parent_table, to_char(range_start, 'YYYY_MM'));

  IF to_regclass(format('public.%I', partition_name)) IS NOT NULL THEN
    RETURN partition_name;
  END IF;

  EXECUTE format(
    'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    partition_name, parent_table, range_start, range_end
  );

  RETURN partition_name;
END
$$;

-- Pre-creates partitions from the current month through `months_ahead`.
--
-- Runs ahead of need deliberately: a partitioned table with no partition covering `now()`
-- rejects the insert outright, which would turn a missed maintenance job into dropped
-- analytics facts and failed writes.
CREATE OR REPLACE FUNCTION ensure_month_partitions(
  parent_table text,
  months_ahead integer DEFAULT 3
) RETURNS SETOF text
LANGUAGE plpgsql AS $$
DECLARE
  offset_month integer;
BEGIN
  IF months_ahead < 0 THEN
    RAISE EXCEPTION 'months_ahead must not be negative, got %', months_ahead;
  END IF;

  FOR offset_month IN 0..months_ahead LOOP
    RETURN NEXT create_month_partition(
      parent_table,
      (date_trunc('month', now()) + make_interval(months => offset_month))::date
    );
  END LOOP;
END
$$;

-- Detaches partitions whose range ends before `cutoff`, returning their names.
--
-- DETACH, never DROP: 05-data-architecture.md §10 requires cold partitions to be exported
-- to object storage as Parquet before removal. A helper that dropped them directly would
-- make silent, unrecoverable data loss a one-line mistake.
CREATE OR REPLACE FUNCTION detach_partitions_before(
  parent_table text,
  cutoff        timestamptz
) RETURNS SETOF text
LANGUAGE plpgsql AS $$
DECLARE
  part        record;
  bound_text  text;
  upper_bound timestamptz;
BEGIN
  FOR part IN
    SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
      FROM pg_class parent
      JOIN pg_inherits i ON i.inhparent = parent.oid
      JOIN pg_class c    ON c.oid = i.inhrelid
     WHERE parent.relname = parent_table
       AND c.relispartition
  LOOP
    -- The bound renders as: FOR VALUES FROM ('2025-01-01 00:00:00+00') TO ('2025-02-01 ...')
    -- Capture the whole literal rather than a date-shaped prefix: our fact tables partition
    -- on timestamptz, so a [0-9-]+ pattern matches nothing at all and the loop silently
    -- detaches no partitions — a maintenance job that appears to work and never ages data out.
    bound_text := (regexp_match(part.bound, $re$TO \('([^']+)'\)$re$))[1];
    CONTINUE WHEN bound_text IS NULL;

    upper_bound := bound_text::timestamptz;
    IF upper_bound <= cutoff THEN
      EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', parent_table, part.relname);
      RETURN NEXT part.relname;
    END IF;
  END LOOP;
END
$$;

-- Maintenance functions belong to the migrator, not the application: partition management
-- is scheduled operational work, never something a request can trigger.
REVOKE EXECUTE ON FUNCTION create_month_partition(text, date)      FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ensure_month_partitions(text, integer)  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION detach_partitions_before(text, timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION create_month_partition(text, date)      TO growth_os_migrator;
GRANT  EXECUTE ON FUNCTION ensure_month_partitions(text, integer)  TO growth_os_migrator;
GRANT  EXECUTE ON FUNCTION detach_partitions_before(text, timestamptz) TO growth_os_migrator;
