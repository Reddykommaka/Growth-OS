# ADR-0021 — Partition maintenance runs in the deploy pipeline; retention waits on archival

**Status:** Accepted · **Date:** 2026-09-19

## Context

[05-data-architecture.md](../architecture/05-data-architecture.md) §7 requires that every
unbounded-growth fact table be RANGE-partitioned by month from day one, and that "a scheduled
job pre-creates partitions 3 months ahead and detaches/archives those past retention".

The machinery has existed since migration 0002 and has tests. **Nothing called it on a
schedule.** The Phase 1 status document recorded this as an open risk after work item 1.15,
and it is not a tidiness problem: a partitioned table with no partition covering `now()`
rejects the insert outright with SQLSTATE 23514. For `audit_events` that means every audited
write in the product failing simultaneously, on the first of a month, with no preceding
symptom and no partial degradation — the one outcome an audit log exists to prevent. The same
now applies to `usage_records`, which backs metered billing.

The obvious home was `apps/worker`, and `apps/worker` has no runtime: it is a package with
`export {}` and a comment deferring the runtime to a later work item. "It belongs to the
worker" was therefore a deferral of an outage-class risk behind an unscheduled dependency, and
that is what forced this decision rather than another postponement.

There is a second, harder constraint that only appears on inspection. The functions that
create partitions must run as `growth_os_migrator`: it is the only role with EXECUTE on them,
and the only role permitted to create tables. A BullMQ worker connects as `growth_os_app`,
which by design holds no CREATE on the schema
([06-identity-and-access.md](../architecture/06-identity-and-access.md) §4). Putting partition
creation in the worker therefore is not a scheduling change — it is a request to give the
request-serving role the ability to create and alter tables.

## Decision

**Pre-creation runs in the deploy pipeline. Retention does not run at all yet, for a stated
reason, with a stated acceptance condition.**

1. **`pnpm db:maintain` is a discrete deploy step**, immediately after the migration job,
   using the same `DATABASE_MIGRATOR_URL` and the same failure semantics: a failure stops the
   deploy. It creates and hardens partitions for every registered table and reports the
   remaining headroom. It is idempotent, which is what makes running it on every deploy the
   whole schedule rather than an approximation of one.

2. **A registry, not a list in the job.** `partition_maintenance` (migration 0014) maps each
   partitioned parent to the function that creates *and hardens* its partitions, plus its
   retention policy. `unregistered_partitioned_tables()` returns partitioned parents with no
   row, and a non-empty result fails the job before it creates anything. Without this, adding
   a partitioned fact table and forgetting the job is invisible until the month its
   pre-created partitions run out.

3. **The registry dispatches per table, and that indirection is load-bearing.** A partition is
   a table in its own right: row security on the parent governs access *through* the parent,
   and migration 0001's default privileges grant the application full DML on anything the
   migrator creates. A job calling `ensure_month_partitions()` generically would manufacture
   an unpoliced, application-writable copy of the audit log every month. Only
   `ensure_audit_partitions` / `ensure_usage_partitions` create and harden in one step.

4. **Headroom is a readiness check.** `partition_headroom()` reports whole months of runway
   per table; `partitionHeadroomCheck` warns below two months and fails the check — without
   removing the replica — once a table has none. It is **non-critical deliberately**: headroom
   is a fact about the schema, identical on every replica, so a critical check would empty the
   load balancer everywhere at once and take down every request that never touches the
   affected table. The condition needs an operator with a migrator credential, which a
   readiness probe does not have.

5. **Retention is deferred, and the reason is not scheduling.**
   [05-data-architecture.md](../architecture/05-data-architecture.md) §10 requires cold
   partitions to reach object storage as Parquet **before** they are dropped.
   `detach_partitions_before()` detaches and never drops, precisely so that a job cannot make
   silent, unrecoverable data loss a one-line mistake. The export path does not exist: object
   storage is not wired up, and neither is a Parquet writer. A retention job shipped before
   them would either drop data that was never archived, or accumulate detached tables nobody
   reattaches. The policy is recorded now, as data, in `partition_maintenance.retention_months`
   and `archive_before_drop`, so the archival job reads it instead of re-deriving it from a
   prose table — and `usage_records.retention_months` is NULL rather than defaulted, because
   its class genuinely is undecided (see Consequences).

**Production acceptance condition for retention.** Retention is complete when all of:
   - object storage is configured and an export writes a detached partition to it as Parquet;
   - the export is verified by reading the written object back and comparing row count and,
     for `audit_events`, the hash chain across the partition boundary;
   - a job detaches only partitions whose upper bound is older than
     `now() - retention_months`, exports, verifies, and only then drops — in that order, with
     the drop conditional on the verification;
   - `archive_before_drop` is honoured: a table marked true is never dropped without a
     verified export;
   - `usage_records.retention_months` has been set by the billing work item;
   - an integration test ages a partition past retention and asserts the full sequence,
     including that a failed verification leaves the partition detached and undropped.

Until every one of those holds, nothing ages any partition out, and no table shrinks.

## Alternatives considered

**Put it in `apps/worker` now.** Rejected on the privilege argument above: it would require
granting the request-serving role CREATE on the schema, which is a far larger change to the
security model than the scheduling problem justifies. Genuinely close on one axis — a worker
gives a cadence independent of deploys, which the deploy pipeline does not — and that is what
decision 4 exists to cover.

**A `pg_cron` job inside the database.** Rejected: it adds an extension that must exist in
every environment including the test cluster, moves an operational schedule out of the
repository where it cannot be reviewed in a diff, and fails invisibly. It remains the obvious
answer if the deploy cadence ever stops being the constraint.

**Widen the pre-created window to twelve months and revisit later.** Rejected as the *only*
measure — it converts a three-month fuse into a twelve-month one and nothing else. It is,
however, an adequate emergency mitigation, which is why `months_ahead` is per-table data
rather than a constant.

**Ship a retention job now and archive later.** Rejected outright: it is the one variant of
this that destroys data. Detach-only with no reattachment plan was also considered and
rejected as accumulating detached tables that look like an outage's aftermath.

## Consequences

**Positive.** The outage-class risk is closed by something that runs today, on real
infrastructure, with no new runtime. Forgetting to register a new partitioned table fails the
deploy rather than surfacing months later. The readiness check turns a silent cliff into a
warning two months out. The retention policy is recorded as data with an explicit acceptance
condition, rather than as a TODO.

**Negative.** The schedule is the deploy cadence. A service that stops deploying for three
months walks into the cliff, and the readiness warning is then the only thing standing in
front of it — a warning that requires someone to be watching. Partition maintenance is now a
step that can fail a deploy for a reason unrelated to the release being deployed.
`usage_records` retains everything indefinitely until the billing work item chooses a class:
its rows are the evidence behind a metered invoice, which makes the Operational class
(90 days) plainly wrong and the Financial class (7 years) plausible, and guessing between them
would either destroy billing evidence or retain personal data longer than necessary.

**Mitigation.** `pnpm db:maintain:check` runs the same assessment without creating anything,
so a monitor can call it on any cadence. `months_ahead` is per-table data, so a service with a
slow deploy cadence can widen its own window without a code change.

**Exit condition / trigger to revisit.** When `apps/worker` has a runtime AND a maintenance
job can obtain a migrator credential without the request-serving role holding it, move
pre-creation there and keep the deploy step as a belt-and-braces idempotent call. Revisit
immediately if any environment's deploy interval approaches the configured headroom.
