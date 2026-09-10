# ADR-0008 — Postgres-first analytics behind an AnalyticsQueryPort

**Status:** Proposed · **Date:** 2026-09-10

## Context
Touchpoints, conversions, clicks, email events and metric snapshots grow far faster than
transactional data and are queried with heavy aggregation.

## Decision
Store analytics facts in PostgreSQL with monthly `RANGE` partitioning and incremental
rollups. Route **all** report reads through an `AnalyticsQueryPort` from the first
implementation.

## Alternatives considered
- **ClickHouse from day one.** Rejected: a second datastore means dual-write consistency, a
  second operational surface and a second query language, bought before the volume that
  justifies it exists.
- **Materialized views.** Rejected: full-refresh cost grows with total history rather than
  with new data, so it degrades exactly as a customer becomes valuable.
- **A managed warehouse (BigQuery/Snowflake).** Rejected for the interactive path: query
  latency and per-query cost do not suit a live product dashboard. Remains right for
  customer-facing data export later.

## Consequences
**Positive:** one datastore to operate and back up; facts and transactional data are
joinable; partition pruning and rollups carry us a long way.

**Negative:** Postgres will eventually be the bottleneck for the largest tenants; rollup jobs
are code we own; partition management is an operational routine.

**Trigger to revisit:** measured — p95 report latency breaching its SLO, or fact-table size
crossing an agreed threshold. Migration then moves `touchpoints`/`conversions` to ClickHouse
behind the same port, fed from the same event stream, with no product-code change.
