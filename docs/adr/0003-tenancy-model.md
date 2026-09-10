# ADR-0003 — Shared schema with RLS; organization + workspace hierarchy

**Status:** Proposed · **Date:** 2026-09-10

## Context
Businesses must be isolated from each other. Agencies are a primary segment and manage many
client brands under one contract. Cross-tenant analytics (our own product metrics) and
per-tenant scale both matter.

## Decision
A shared schema. Every tenant-scoped table carries `organization_id`; workspace-scoped
tables additionally carry `workspace_id`. Isolation is enforced by PostgreSQL Row-Level
Security, with tenant context set per transaction via `SET LOCAL app.organization_id`. The
application role is `NOBYPASSRLS`; a `BYPASSRLS` migrator role is used only by the migration
job. Two levels of hierarchy: **organization** (billing/tenant boundary) and **workspace**
(operational container).

## Alternatives considered
- **Database per tenant.** Rejected: migration cost scales with customer count; cross-tenant
  queries become impossible; connection management degrades badly.
- **Schema per tenant.** Rejected: same migration problem, plus catalogue bloat at thousands
  of tenants.
- **Application-only filtering (`WHERE organization_id = …`).** Rejected: one forgotten
  clause is a breach. There is no backstop.
- **Single-level tenancy (organization only).** Rejected: forces agencies into either one
  account per client or shared visibility between clients. Neither is acceptable.

## Consequences
**Positive:** one migration path regardless of customer count; isolation survives
application bugs; cross-tenant analytics stay possible; agencies are served natively.

**Negative:** RLS adds query-planning overhead; every connection must set context correctly;
a Postgres-level misconfiguration would be systemic. `SET LOCAL` (not `SET`) is mandatory
under transaction pooling, and this constraint must be understood by every contributor.

**Guarantees:** four CI tests — schema completeness, role posture, cross-tenant probes, and
missing-context fail-closed — make the control structural rather than procedural.
