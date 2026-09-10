# ADR-0003 — Shared schema with RLS; organization + workspace hierarchy

**Status:** Accepted · **Date:** 2026-09-10 · **Approved:** 2026-09-10 (revised before acceptance to add the team layer)

## Context
Businesses must be isolated from each other. **Marketing and social agencies managing
multiple clients are the primary customer**, and direct businesses must be supported
natively rather than as a degraded case. Agency staff are grouped into pods that each serve
a set of clients; access must follow the pod, and must survive a client being added to it.
Cross-tenant analytics (our own product metrics) and per-tenant scale both matter.

## Decision
A shared schema with a **three-level hierarchy**:

```
Organization        ← tenant + billing boundary
  └── Team          ← staffing / access grouping
        └── Workspace   ← the resource boundary
```

Every tenant-scoped table carries `organization_id`; workspace-scoped tables additionally
carry `workspace_id`. Isolation is enforced by PostgreSQL Row-Level Security, with context
set per transaction via `SET LOCAL app.organization_id` and `SET LOCAL app.workspace_ids`.
The application role is `NOBYPASSRLS`; a `BYPASSRLS` migrator role is used only by the
migration job.

**Teams are deliberately excluded from the RLS predicate.** Roles are assignable at
organization, team and workspace scope, but team membership is resolved *in the application
layer* into the actor's accessible-workspace set, which is then handed to the database as a
concrete list. The isolation predicate stays two-level.

A workspace is owned by at most one team (`workspaces.team_id`, nullable); additional teams
gain access through `team_workspace_access`, covering specialist pods that work across
several clients.

## Alternatives considered
- **Database per tenant.** Rejected: migration cost scales with customer count; cross-tenant
  queries become impossible; connection management degrades badly.
- **Schema per tenant.** Rejected: same migration problem, plus catalogue bloat at thousands
  of tenants.
- **Application-only filtering (`WHERE organization_id = …`).** Rejected: one forgotten
  clause is a breach. There is no backstop.
- **Single-level tenancy (organization only).** Rejected: forces agencies into either one
  account per client or shared visibility between clients. Neither is acceptable.
- **Two-level (organization → workspace), with teams as a flat tag.** Rejected: adding a
  client to a pod would require granting access person by person, and offboarding would
  require finding every one of those grants. Access must follow the pod.
- **Team inside the RLS predicate.** Rejected: it puts a three-way join into every policy on
  every query, and it breaks the moment a workspace is served by two teams — which
  `team_workspace_access` exists to support. Access *expansion* belongs in the authorization
  layer; the database keeps the hard, narrow boundary.

## Consequences
**Positive:** one migration path regardless of customer count; isolation survives
application bugs; cross-tenant analytics stay possible; agency staffing changes are
team-membership changes rather than combinatorial re-granting; teams can grow in
expressiveness (nested teams, time-boxed client access) without touching a policy or a
migration.

**Negative:** RLS adds query-planning overhead; every connection must set context correctly;
a Postgres-level misconfiguration would be systemic. `SET LOCAL` (not `SET`) is mandatory
under transaction pooling. Three role scopes plus resource grants is materially more
permission surface to reason about and test. The team layer is UI noise for direct
businesses, and must collapse in the interface when it carries no information.

**Guarantees:** four CI tests — schema completeness, role posture, cross-tenant probes, and
missing-context fail-closed — make the control structural rather than procedural.
