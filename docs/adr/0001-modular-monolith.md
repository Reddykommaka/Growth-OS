# ADR-0001 — Modular monolith over microservices

**Status:** Proposed · **Date:** 2026-09-10

## Context
Growth OS spans three products that must behave as one ecosystem. Its central value claim
is an attribution chain — social activity → content → campaign → lead → deal → revenue —
that is join-heavy, transaction-heavy and expected to be correct on read. The team at the
outset is small.

## Decision
Build a modular monolith: one codebase, one database, deployed as three processes
(`web`, `api`, `worker`). Business logic lives in independently-versioned module packages
that may only communicate through published contracts and domain events.

## Alternatives considered
- **Microservices per product.** Rejected: it turns the core feature into distributed joins
  and sagas, multiplies the operational surface, and imposes eventual consistency exactly
  where customers demand a correct number.
- **Unstructured monolith.** Rejected: no boundary means no extraction path, and coupling
  compounds silently.
- **Modular monolith with a single deployable.** Rejected: background work has a different
  scaling and failure profile from request handling and must scale independently.

## Consequences
**Positive:** transactional integrity within aggregates; cross-product queries are SQL;
one migration path and one trace context; extraction remains possible module by module.

**Negative:** all modules share a runtime, so a memory leak or CPU spike in one affects
others; deploys are all-or-nothing; boundary discipline must be *enforced* because it is not
imposed by the network. We accept these and mitigate the last with four mechanical
enforcement mechanisms (see [03](../architecture/03-repository-structure.md) §2).

**Exit condition:** extract a module when its load profile genuinely diverges. The event
spine is the seam; the contract interface becomes an HTTP client.
