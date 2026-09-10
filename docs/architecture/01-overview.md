# 01 — Recommended Production Architecture

## 1. The shape of the system

Growth OS is a **modular monolith deployed as three long-lived processes**, sharing one
codebase, one database and one event spine.

```
                         ┌──────────────────────────────────────────┐
   Browser ──────────────▶  apps/web        Next.js 16 (Node)       │
   (dashboard,            │  • RSC dashboard, marketplace storefront │
    storefront)           │  • BFF: server actions + route handlers  │
                          └───────────────┬──────────────────────────┘
                                          │ in-process import
   Partners, API keys ────▶┌──────────────▼──────────────────────────┐
   Provider webhooks ─────▶│  apps/api      Fastify 5                │
                          │  • /v1 public REST (OpenAPI from Zod)    │
                          │  • /v1/webhooks/:provider receivers      │
                          └───────────────┬──────────────────────────┘
                                          │ in-process import
                          ┌───────────────▼──────────────────────────┐
   Timers, queue ────────▶│  apps/worker   BullMQ consumers          │
                          │  • outbox relay, automation runtime,     │
                          │    publishing, ingestion, rollups,       │
                          │    intelligence jobs                     │
                          └───────────────┬──────────────────────────┘
                                          │
   Social clicks ────────▶┌───────────────▼──────────────────────────┐
                          │  apps/link     redirect service          │
                          │  • tracked-link resolution → touchpoint  │
                          └───────────────┬──────────────────────────┘
                                          │
        ┌─────────────────────────────────▼─────────────────────────────────┐
        │  packages/modules/*   ← ALL business logic lives here             │
        │  identity · organization · social · marketing · crm ·             │
        │  marketplace · billing · analytics · intelligence                 │
        └─────────────────────────────────┬─────────────────────────────────┘
                                          │
   ┌───────────┬───────────┬──────────────┼──────────┬──────────┬──────────┐
   ▼           ▼           ▼              ▼          ▼          ▼          ▼
 PostgreSQL  Redis 7   Object storage  Providers  Model      Vector    OTel /
 16 (+RLS,  (queues,  (S3-compatible,  (social,   providers  index     Sentry
 outbox,     rate      presigned URLs)  ads,       (Anthropic (pgvector)
 partitions) limits)                    email,     OpenAI, …)
                                        Stripe)
```

The four processes are **deployment units, not architectural boundaries**. The
architectural boundaries are the modules, and they are enforced in code
([03](03-repository-structure.md), [04](04-domain-architecture.md)).

`apps/link` is separated from `apps/web` deliberately and early: the tracked-link redirect
is the mechanism the entire attribution spine depends on ([09](09-analytics-architecture.md) §3),
it has a p99 budget of 50 ms, and it must stay up through a dashboard incident. It is small
enough that separating it costs almost nothing and large enough in consequence that
co-locating it would be a mistake.

### All three products are first-class from the start

Commercial sequencing is **Social → Marketing → Marketplace**. Architectural standing is
**equal**. Marketplace's domain model, contracts, events, permission catalogue and money
primitives are designed and reviewed in the foundation phases alongside the others; only
its *feature implementation* follows the commercial order. Concretely, that means the
double-entry ledger, `Money` type, listing-type extensibility model and marketplace event
contracts land in Phases 0–2, not Phase 7. Nothing about Marketplace is designed as
disposable or retrofitted later.

## 2. Why a modular monolith rather than microservices

This is the single most consequential structural decision, so it is argued explicitly.

Growth OS's value proposition is that social activity, marketing spend and marketplace
purchases resolve into **one attribution chain ending in revenue**. That chain is a
join-heavy, transaction-heavy, strongly-consistent read path. Splitting it across services
on day one would mean distributed joins, eventual consistency in the exact place where
customers demand a correct number, and a saga for every write that spans two products.

The modular monolith gives us:

- **Transactional integrity** where the domain requires it (an order, its commission
  ledger entries, its audit record and its outbox event commit atomically).
- **Cheap cross-product reads** — attribution queries are SQL joins, not fan-out RPC.
- **Real boundaries anyway**, because modules may only talk through published contracts
  and domain events. A module that respects that discipline can be extracted into its own
  service later by replacing an in-process contract implementation with an HTTP client —
  without touching its callers.
- **One deployment, one migration path, one trace context** while the team is small.

The exit ramp is explicit: `apps/worker` is already a separate process, so any module
whose load profile diverges (ingestion, rendering, ML scoring) is extracted first, and the
event spine ([08](08-automation-architecture.md)) is the seam it leaves through.
Recorded as [ADR-0001](../adr/0001-modular-monolith.md).

## 3. Core architectural principles

These are enforceable rules, not aspirations. Each has a mechanism.

| # | Principle | Enforcement mechanism |
| --- | --- | --- |
| 1 | **Business logic never lives in UI or HTTP handlers.** | Lint rule: `apps/**` may not import `packages/modules/*/{domain,infrastructure}` — only `contracts`. Handlers may only call application services. |
| 2 | **Every tenant-scoped table has RLS.** | Generated test enumerates `information_schema` and fails CI if a table with `organization_id` lacks an enabled policy ([11](11-testing-architecture.md)). |
| 3 | **Authorization is asserted server-side, twice.** | Application services require an `ActorContext` and call `authz.assert(...)`; Postgres RLS is the independent second gate ([06](06-identity-and-access.md)). |
| 4 | **Modules communicate through contracts and events only.** | `package.json` `exports` exposes only `./contracts`; deep imports fail to resolve. Dependency-cruiser check in CI. |
| 5 | **No cross-module foreign keys except to platform tables.** | Migration lint: FKs are permitted within a module's own tables and to `organizations`/`workspaces`/`users`; anything else requires an ADR. |
| 6 | **State changes emit domain events transactionally.** | Writes go through a `UnitOfWork` that persists to `outbox_events` in the same transaction; a relay publishes them ([08](08-automation-architecture.md)). |
| 7 | **Money is integer minor units + ISO-4217 code.** | Branded `Money` type; no `float`/`number` money columns permitted by migration lint. |
| 8 | **All timestamps are `timestamptz`, stored UTC.** | Migration lint rejects `timestamp without time zone`. User-intent times additionally store an IANA zone ([05](05-data-architecture.md) §8). |
| 9 | **Every external boundary is validated with Zod.** | HTTP handlers, queue payloads, webhook bodies and env vars all parse before use; unparsed input never reaches a service. |
| 10 | **`any` is a build error.** | `noImplicitAny`, `strict`, and an ESLint rule banning explicit `any` and non-null `!` outside tests. Escape hatch is `unknown` + a parser. |
| 11 | **Secrets never reach the client.** | Env schema splits `server` and `client` (`NEXT_PUBLIC_` prefix required for the latter); a build-time check fails if a server key is referenced in a client bundle. |
| 12 | **Failure is a designed state.** | Every subsystem documents its failure mode and recovery in its architecture doc; retries are idempotent by construction. |
| 13 | **No model provider SDK outside its adapter.** | `@anthropic-ai/sdk`, `openai` and peers are lint-banned everywhere except `packages/integrations/<provider>`. Product code depends on `IntelligencePort`, never on a vendor. |
| 14 | **Every AI output carries provenance.** | Model, version, prompt version, inputs hash, grounding sources, cost and latency are persisted with the result. An output that cannot be explained cannot be shipped ([16](16-intelligence-architecture.md)). |
| 15 | **AI never writes to the domain unattended.** | Intelligence produces *proposals*; a human or an explicitly-configured automation applies them, through the same application services and authorization as any other write. |

## 4. Request lifecycle (the canonical path)

Every write in the system follows the same seven steps. Consistency here is what makes the
platform auditable and testable.

1. **Transport** (`apps/web` server action, or `apps/api` route) parses input with Zod and
   resolves the caller into an `ActorContext` — `{ userId, organizationId, workspaceId?,
   roles, permissions, apiKeyId?, requestId, ipAddress, userAgent }`.
2. **Authorization** — the application service calls `authz.assert(actor, 'social.post:publish', resource)`.
   Denial throws `ForbiddenError` before any data access.
3. **Transaction opens** and immediately executes
   `SET LOCAL app.organization_id / app.user_id`, which is what RLS policies read.
   The connection uses the RLS-enforced role, never a bypass role.
4. **Domain logic** — entities enforce their own invariants; the service orchestrates.
5. **Persistence** through repositories scoped to the module.
6. **Side effects staged, never executed inline** — domain events and audit records are
   written to `outbox_events` and `audit_events` inside the same transaction.
7. **Commit.** Only afterwards does the relay publish events to the queue, where consumers
   perform I/O (provider calls, email, analytics ingestion) with idempotency keys.

The rule that falls out of this: **no HTTP call to a third party ever happens inside a
database transaction.** That single constraint eliminates the most common source of
connection-pool exhaustion and partial-write corruption in products of this kind.

## 5. Consistency model

| Concern | Guarantee | Mechanism |
| --- | --- | --- |
| Within an aggregate (order + items + ledger) | Strong, ACID | Single Postgres transaction |
| Across modules (order → analytics) | Eventual, at-least-once, idempotent | Outbox → queue → idempotent consumer |
| Publishing to a provider | At-least-once with dedup | Idempotency key persisted before the call, checked on retry |
| Analytics rollups | Eventual, recomputable | Incremental rollups keyed by (org, date, dims); full recompute is always possible from facts |
| Entitlement checks | Strong at check time | Read in the same transaction as the gated write |

## 6. What this architecture explicitly refuses

- **No GraphQL gateway.** Authorization on a graph is materially harder to get right than
  on explicit endpoints, and N+1 control becomes a permanent tax. Rejected in [ADR-0004](../adr/0004-api-surfaces.md).
- **No schema-per-tenant or database-per-tenant.** Migration cost grows linearly with
  customers and cross-tenant analytics becomes impossible. Rejected in [ADR-0003](../adr/0003-tenancy-model.md).
- **No "sync the whole provider account into our tables" ingestion.** Ingestion is
  incremental, cursor-based and capped ([07](07-integration-architecture.md)).
- **No analytics that are not derived from stored facts.** Every headline number must be
  drillable to the rows that produced it ([09](09-analytics-architecture.md)).
- **No AI calls scattered through UI components.** Every model interaction goes through the
  intelligence layer, which owns prompts, grounding, routing, caching, cost control,
  evaluation and provenance ([16](16-intelligence-architecture.md)).
- **No Kubernetes or service mesh** until a demonstrated requirement exists
  ([12](12-devops-architecture.md) §9).
- **No auto-migrate on application boot.** Migrations are a discrete, gated pre-deploy job
  ([12](12-devops-architecture.md)).
