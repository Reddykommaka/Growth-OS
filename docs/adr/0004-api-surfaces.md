# ADR-0004 — Server Actions for first-party, versioned REST for public; no GraphQL

**Status:** Proposed · **Date:** 2026-09-10

## Context
Two consumers with different needs: our own dashboard (fast iteration, end-to-end types) and
external partners/API-key holders (stability, versioning, documentation, rate limits).

## Decision
The first-party dashboard uses **Next.js Server Actions and route handlers**. External
consumers use a **versioned REST API** in `apps/api`, with OpenAPI 3.1 generated from the
same Zod schemas that validate requests. Both are thin adapters over identical application
services.

## Alternatives considered
- **GraphQL for everything.** Rejected: per-field authorization is materially harder to get
  right than per-endpoint; N+1 control becomes a permanent tax; query-cost limiting is
  required before exposing it publicly. The flexibility does not pay for the correctness risk.
- **tRPC for first-party.** Rejected: Server Actions already provide end-to-end types; tRPC
  would be a third surface duplicating that while contributing nothing to the public API we
  must ship anyway.
- **One REST API for both.** Rejected: it would force our dashboard's rapid iteration through
  a versioned public contract.

## Consequences
**Positive:** authorization is explicit per operation; the public spec cannot drift from the
validating code; the dashboard iterates without breaking partners.

**Negative:** two transports over the same services; discipline is required to keep logic out
of both. Enforced by lint: `apps/**` may not import module internals, only `contracts`.
