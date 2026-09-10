# 14 — Development Phases

*Revised 2026-09-10 to implement the approved strategic decisions: commercial order
Social → Marketing → Marketplace, agency-first tenancy, Tier 1/Tier 2 platform coverage, AI
as a platform capability, and the attribution spine as foundational.*

## Sequencing principles

1. **Ordered by irreversibility, not visibility.** Tenancy, the event spine, the money
   primitives and the attribution model cannot be cheaply changed once real data exists.
   They come first even though they demo poorly.
2. **Commercial order ≠ architectural order.** Social ships first commercially. All three
   products' domain models, contracts, events and permissions are designed in the foundation
   phases. Marketplace is never a retrofit.
3. **Every phase produces production-quality, tested, documented, deployable code.** No phase
   produces scaffolding to be replaced. There is no throwaway increment and no MVP stage.
4. **A phase is not done until its failure modes are drilled**, not merely documented.

Durations assume a small senior team and should be re-based once team shape is known
([15](15-risks.md) §3).

---

## Phase 0 — Foundation *(~2.5 weeks)*
**Goal:** a repository where correct code is the path of least resistance and incorrect code
fails the build.

Fully specified in **[18-phase-0-plan.md](18-phase-0-plan.md)**.

- pnpm workspace + Turborepo; `apps/{web,api,worker,link}` and `packages/*` with real,
  enforced boundaries.
- `packages/platform/{config,types,errors,logger,telemetry}` — including the `Money` branded
  type and branded id types.
- Database harness (`initdb` cluster, template cloning, transaction rollback), migration
  runner, and the full migration lint rule set.
- Design tokens, theming, first primitives, Storybook.
- CI: static → security → unit → integration → build → E2E; preview deploys.
- Terraform skeleton for staging; container build; health endpoints.
- `SECURITY.md`, `CONTRIBUTING.md`, ADR process, gitleaks pre-commit.

**Exit:** a trivial endpoint deploys to staging through the full pipeline, and CI already
fails on a boundary violation, a missing RLS policy, a float money column and a committed
secret.

---

## Phase 1 — Tenancy & access *(~5 weeks)*
**Goal:** the agency-first security model, complete and provably correct.

- `identity`: users, sessions, Argon2id passwords, email verification, TOTP MFA, OAuth login,
  device management.
- `organization`: **organizations → teams → workspaces**, memberships, team memberships,
  `team_workspace_access`, invitations, three-scope role assignments, custom roles, API keys,
  settings at each level.
- `platform/authz`: policy engine, full permission catalogue, accessible-workspace-set
  resolution, `client_guest` role.
- **RLS on every tenant table**, plus all four structural isolation suites.
- **Dual onboarding paths** — agency and direct business — provisioning the right hierarchy
  shape, with the team layer collapsing in the UI when it carries no information.
- `platform/audit` (hash-chained), `platform/entitlements`, `platform/notifications`,
  `platform/files`, `platform/i18n`.
- App shell, workspace/client switcher, command palette, settings, dark/light themes.

*+1 week vs. the original plan: the team layer, three-scope authorization and `client_guest`
are real additional scope, and this is the phase where getting them wrong is most expensive.*

**Exit:** authorization matrix and cross-tenant probe suites at 100%; an agency E2E (two
pods, four clients, a client guest) passes; a reviewer can verify isolation from
`db/policies/` alone.

---

## Phase 2 — Event spine, jobs, integrations, money & AI platform *(~6 weeks)*
**Goal:** every piece of machinery the product phases depend on — including the ones that
must exist before Marketplace and AI features can be built without retrofitting.

- `platform/events`: registry, transactional outbox, relay, typed bus, versioning rules.
- `platform/jobs`: BullMQ adapter, in-memory fake, idempotency, retry, DLQ, `job_executions`.
- `integrations/core`: ports, registry, capability manifests, credential vault (envelope
  encryption + rotation), OAuth lifecycle, rate limiter, circuit breaker, normalized error
  taxonomy, webhook receiver, `sync_cursors`.
- `integrations/testkit`: the shared adapter contract suite.
- **`integrations/meta-core`** — shared Meta auth, transport, webhooks and rate-limit budget
  ([ADR-0015](../adr/0015-meta-provider-family.md)).
- `billing`: plans, Stripe Billing subscriptions, invoices, **workspace-aware metering**,
  dunning.
- **Money foundation:** `Money` type, `PaymentPort`, Stripe adapter, and the **double-entry
  ledger** with its posting API and balance-assertion job. Platform billing posts to it from
  day one.
- **AI platform:** `ModelProviderPort`, first provider adapter, model router, prompt
  registry, `ai_invocations` ledger, budget guard, cache, evaluation harness. No
  product-facing capability yet — the platform only ([16](16-intelligence-architecture.md) §9).
- **Marketplace contracts** — domain events, permission literals and listing-type model
  defined and reviewed, implementation deferred.
- Admin surfaces: queue health, DLQ inspection/replay, connection health, AI spend.

*+2 weeks vs. the original plan: the ledger, the AI platform and the Meta core all move
earlier because each is materially more expensive to retrofit than to build now.*

**Exit:** one Tier 1 provider connects end to end; token refresh, rate limiting, circuit
breaking, webhook replay and DLQ replay each demonstrated by test and drill; the ledger
balances under property test; an AI capability can be invoked, budgeted, cached, evaluated
and traced.

---

## Phase 3 — Social Growth OS *(~9 weeks)*
Commercial priority 1.

- Social accounts and connection health per workspace.
- **Tier 1 adapters: Instagram, Facebook, YouTube, LinkedIn, TikTok** (Instagram, Facebook
  and Threads over `meta-core`).
- Content items and per-platform variants; media library; manifest-driven composer validation.
- Calendar, planning, content pillars; agency-grade multi-client calendar views.
- Approval workflows including **client approval via `client_guest`** — the agency's core
  daily loop.
- Publishing: DST-correct scheduling, claim-based dispatch, idempotent publish, attempts,
  retries, reconciliation.
- Unified inbox: comments, DMs, mentions; assignment, saved replies, SLA timers.
- Listening monitors and competitor tracking.
- Metric ingestion (upsert-by-grain) and performance views.
- **AI capabilities:** content generation and transformation, grounded in brand voice and
  platform manifests.

**Exit:** a post scheduled for 09:00 local publishes within the punctuality SLO across a DST
boundary; a provider outage degrades visibly and recovers without duplicates; an agency can
run a full week for four clients with client-side approvals.

---

## Phase 3.5 — Tier 2 platforms *(~2 weeks)*
X, Pinterest, Threads. Deliberately a separate phase to **prove the abstraction**: if adding
these requires editing anything outside their own packages and a manifest row, the provider
abstraction has failed and is fixed before more platforms are added.

---

## Phase 4 — Marketing OS core & the attribution spine *(~8 weeks)*
Commercial priority 2. The attribution spine is foundational, per Decision 6.

- Strategy: positioning, ICPs, segments, offers, research.
- **Campaigns** — the cross-product spine.
- **`apps/link` + tracked links** — the social→revenue bridge, with its 50 ms p99 budget.
- Landing pages, forms, lead capture; consent handling.
- `crm`: contacts, companies, deals, pipelines, activities, custom fields, scoring, assignment.
- Email/messaging sends and sequences; follow-up cadences.
- Ad accounts and ad-platform ingestion including `ad_spend_facts` — real cost data, so CPL
  and CAC are measured, not estimated.
- `analytics` foundations: identity graph, touchpoints, conversions, cost facts.
- **AI capabilities:** research, trend analysis, listening summarisation; embeddings and
  hybrid retrieval.

**Exit:** the end-to-end chain test passes — a published social post produces a click, a
lead, a qualified contact, a won deal, and revenue attributed back to that post, with
evidence.

---

## Phase 5 — Automation engine *(~4.5 weeks)*
- Definitions, immutable versions, triggers (event / schedule / webhook / manual).
- Runtime: conditions, branching, delays, waits, parallel, bounded loops, sub-automations.
- Idempotent steps, retry policies, timeouts, recursion guard, per-plan limits.
- **Intelligence nodes** with pre-invocation budget checks and explicit auto-apply gating.
- Visual builder; run inspector; cancel, retry-from-step, replay.

**Exit:** chaos drills produce the documented behaviour; a run's full history — including
which model, prompt version and inputs produced a generated caption — is explicable from
the UI in under a minute.

---

## Phase 6 — Analytics, attribution & intelligence grounding *(~6 weeks)*
- Attribution models with stored model/version/lookback **and source evidence**.
- `attribution_computations` audit records; incremental recomputation.
- Metric registry; incremental rollups; `AnalyticsQueryPort`.
- Dashboards, report builder, drill-through to source rows, scheduled exports.
- Funnel, cohort and campaign ROI; social→revenue reporting; **per-client (workspace)
  reporting for agencies**, including client-shareable report views.
- **Knowledge graph, feature store, lead scoring, analytics explanation** — these require
  attribution to exist first ([16](16-intelligence-architecture.md) §9).

**Exit:** every headline number drills to its rows and its evidence; credit fractions sum to
1.0 per conversion per model; incremental rollups equal a full rebuild.

---

## Phase 7 — Marketplace *(~9 weeks)*
Commercial priority 3, built against contracts and money primitives that have existed since
Phase 2.

- Listing types, categories, attribute definitions and values; new categories without migrations.
- Seller onboarding and verification via Stripe Connect; buyer and seller profiles.
- Search, facets, ranking, discovery.
- Cart, orders, fulfilment, digital delivery, **entitlement provisioning** (a purchased
  template instantiates a real campaign through the owning module's service).
- Payments, refunds, commissions, payouts; ledger extension and Stripe reconciliation.
- Reviews (order-verified), moderation queue, disputes.
- Marketplace touchpoints and conversions flow into attribution.

**Exit:** the ledger balances to zero across randomised order/refund/payout sequences;
Stripe reconciliation is exact; the marketplace-specific security suite passes; a purchased
template provisions a working campaign.

---

## Phase 8 — Recommendation engine *(~5 weeks)*
The cross-product intelligence layer's payoff, deliberately last because it depends on
attribution (Phase 6) and marketplace supply (Phase 7).

- Detectors across content, campaign, budget, audience, lead, channel, workflow, marketplace
  and revenue-growth opportunities.
- Scoring, ranking, dedupe, cooldowns, lifecycle.
- **Applied-vs-predicted impact measurement**; detector demotion on underperformance.
- In-product surfacing with rationale and evidence.

**Exit:** every recommendation carries rationale, evidence and expected impact; applied
outcomes are measured against predictions; a detector that does not perform is demoted
automatically.

---

## Phase 9 — Enterprise & public platform *(~5 weeks)*
- Public REST API v1 with generated OpenAPI, API-key scopes, per-key rate limits.
- Outbound webhooks with signing, retries and rotation.
- SAML/OIDC SSO and SCIM behind `EnterpriseIdentityPort`.
- Custom roles UI, access reviews, session policy, org-wide MFA enforcement.
- Data export/erasure workflows; residency routing.
- External penetration test; SOC 2 readiness evidence.

---

## Phase 10 — Scale hardening *(continuous from Phase 6)*
Read replicas and explicit read routing; PgBouncer tuning; partition automation and Parquet
archival; load testing at 10× projected volume; query-budget enforcement. ClickHouse behind
`AnalyticsQueryPort` **only if** measured thresholds are crossed; module extraction **only
if** a load profile genuinely diverges.

---

## Critical path and parallelisation

Phases 0–2 are strictly sequential — everything depends on them. From Phase 3 the work
splits along module boundaries, which is the practical payoff of the boundary discipline in
[03](03-repository-structure.md).

```
 P0 ─▶ P1 ─▶ P2 ─┬─▶ P3 (social) ──▶ P3.5 (tier 2) ─┐
                 │                                   ├─▶ P6 (analytics+grounding) ─┬─▶ P8 (recommendations)
                 ├─▶ P4 (marketing/crm/attribution) ─┘                             │
                 ├─▶ P5 (automation) ────────────────────────────────────────────  │
                 └─▶ P7 (marketplace) ─────────────────────────────────────────────┘
                                                                              P9, P10 ─▶
```

Three parallel streams from Phase 3: **Social**, **Marketing/CRM/attribution**, and
**Automation + Marketplace**. Phase 6 is the join point; Phase 8 depends on both 6 and 7.

**Roughly 60 engineering weeks on the critical path**, ~46 of them before the first
commercial product (Social) is complete at end of Phase 3.

## Definition of done (every phase, no exceptions)

Typed with no `any` · authorization asserted and tested at all three scopes · RLS present
and probed · domain events emitted transactionally · jobs idempotent · AI invocations
budgeted, evaluated and provenance-recorded · failure modes documented **and drilled** ·
observability instrumented with alerts and runbooks · tests at every relevant level with
coverage gates met · accessibility verified · documentation and ADRs updated · migrations
expand/contract and reviewed · deployed to staging and soaked.
