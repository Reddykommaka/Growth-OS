# ADR-0007 — Transactional outbox for domain events

**Status:** Accepted · **Date:** 2026-09-10 · **Approved:** 2026-09-10

## Context
Domain writes must reliably produce side effects (analytics facts, automation triggers,
notifications, audit). Writing to Postgres and publishing to Redis are two systems: publish
before commit and you announce changes that never happened; publish after commit and a crash
loses the event.

## Decision
Write domain events to an `outbox_events` table **inside the same transaction** as the state
change. A relay in `apps/worker` polls unpublished rows with `FOR UPDATE SKIP LOCKED`,
publishes to BullMQ, and marks them published. Delivery is at-least-once; every consumer is
idempotent on event id.

## Alternatives considered
- **Publish directly after commit.** Rejected: loses events on crash — the dual-write problem.
- **Two-phase commit across Postgres and Redis.** Rejected: operationally fragile, poorly
  supported, and slow.
- **Change-data-capture (Debezium/logical replication).** Rejected for now: adds significant
  infrastructure, and CDC emits row changes rather than domain events, which forces
  reconstruction of intent downstream. Remains a viable later swap for the relay.

## Consequences
**Positive:** no event is ever lost; a Redis outage degrades throughput rather than
correctness; the relay scales horizontally safely via `SKIP LOCKED`.

**Negative:** an extra write per domain change; relay lag is a new thing to monitor
(alerted); consumers must be idempotent — treated as a required job property, not an
optional one; strict global ordering is not provided (per-organization ordering is).
