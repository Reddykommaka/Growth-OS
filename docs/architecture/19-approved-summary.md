# 19 — Approved Architecture Summary

*Consolidates the architecture as approved on 2026-09-10, after the strategic decisions were
applied. This is the reference view; each section links to the document that owns the detail.*

---

## 1. Final architecture summary

**Growth OS is a multi-tenant, agency-first operating system for business growth**, built as
a modular monolith deployed as four processes over one PostgreSQL database and one event
spine. Three products — Social Growth OS, Marketplace, Marketing OS — are architecturally
equal peers; only their delivery order differs.

| Dimension | Decision |
| --- | --- |
| **Shape** | Modular monolith; `apps/{web,api,worker,link}`; 10 business modules; 19 platform packages ([01](01-overview.md)) |
| **Tenancy** | Organization → **Team** → Workspace. Shared schema, RLS on `organization_id` + `workspace_id`; teams resolve in the application layer, not in the policy ([ADR-0003](../adr/0003-tenancy-model.md)) |
| **Language** | TypeScript 7 `strict`, Node 22, no `any` |
| **Data** | PostgreSQL 16 + pgvector, Drizzle confined to `infrastructure/`, hand-reviewed SQL migrations, monthly partitions on all fact tables ([05](05-data-architecture.md)) |
| **AuthN/AuthZ** | Own identity tables; opaque revocable sessions; three-scope RBAC + resource grants; `client_guest` for agency clients; RLS as an independent backstop ([06](06-identity-and-access.md)) |
| **Integrations** | Ports + capability manifests; Tier 1 Instagram/Facebook/YouTube/LinkedIn/TikTok, Tier 2 X/Pinterest/Threads; `meta-core` shares one Meta credential and budget ([07](07-integration-architecture.md), [ADR-0015](../adr/0015-meta-provider-family.md)) |
| **Events** | Transactional outbox → BullMQ; at-least-once, idempotent consumers ([ADR-0007](../adr/0007-transactional-outbox.md)) |
| **Automation** | Data-driven engine; immutable versions; resumable state machine; intelligence nodes with budget guards ([08](08-automation-architecture.md)) |
| **Attribution** | Foundational, not a feature. Identity graph → tracked links → touchpoints → conversions → per-model results with **version, lookback and source evidence** ([09](09-analytics-architecture.md)) |
| **Intelligence** | Platform capability, not scattered calls. Provider-abstracted, grounded in the knowledge graph and attributed outcomes, emits proposals only ([16](16-intelligence-architecture.md)) |
| **Marketplace** | First-class domain; contracts and money primitives in Phase 2, features in Phase 7; double-entry ledger ([17](17-marketplace-architecture.md)) |
| **Money** | Integer minor units + double-entry ledger, used by platform billing from Phase 2 ([ADR-0012](../adr/0012-money-and-ledger.md)) |
| **Deployment** | Four containers, managed Postgres/Redis/storage, Terraform, cloud-portable. **No Kubernetes, no service mesh, no warehouse** until a named trigger fires ([12](12-devops-architecture.md) §9) |
| **Design** | Own token-based system on Radix primitives; dense, keyboard-first, WCAG 2.2 AA ([13](13-design-system.md)) |

### The five load-bearing ideas

1. **Boundaries are mechanical, not cultural.** Four independent enforcement mechanisms mean
   an architecture violation is a red build, not a review conversation.
2. **Isolation is enforced twice, at different layers.** Application authorization is
   expressive; RLS is unbypassable. A missed check becomes a permissions bug, not a breach.
3. **Attribution is plumbing, not reporting.** Tracked links and the identity graph exist
   from Phase 4 because "which post produced revenue?" is otherwise structurally unanswerable.
4. **AI is governed infrastructure.** Provenance, budgets, evaluation and human-in-the-loop
   exist before the first capability, because none can be reconstructed retroactively.
5. **Money is append-only.** Double-entry from Phase 2, so a balance is always explicable.

---

## 2. Updated domain map

```
┌──────────────────────────── PLATFORM (19 packages, no business rules) ────────────────────────────┐
│ config · types(Money, branded ids, Clock) · errors · logger · telemetry · db · events · jobs      │
│ cache · ratelimit · authn · authz · entitlements · audit · notifications · files · search · i18n  │
│ automation                                                                                        │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
                                              ▲ used by all modules
┌─────────────────────────────── TENANCY & COMMERCE CORE ───────────────────────────────────────────┐
│  identity ──▶ organization ──▶ billing                                                            │
│               (Organization → Team → Workspace)   (workspace-aware metering)                      │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
                                              ▲
┌── SOCIAL GROWTH OS ──────────┬── MARKETING OS ──────────────┬── MARKETPLACE ────────────────────┐
│ social                        │ marketing        crm         │ marketplace                       │
│ accounts · content · calendar │ strategy · campaigns · ads   │ listings · orders · payments      │
│ approvals · publishing        │ landing pages · forms        │ commissions · payouts · ledger    │
│ inbox · listening · metrics   │ tracked links · email        │ reviews · disputes · moderation   │
│                               │ contacts · deals · pipelines │                                   │
│ commercial 1                  │ commercial 2                 │ commercial 3                      │
└───────────────────────────────┴──────────────────────────────┴───────────────────────────────────┘
                                     │ all emit domain events (outbox)
                                     ▼
┌──────────────────────────────────── analytics ────────────────────────────────────────────────────┐
│ identity graph · touchpoints · conversions · cost facts · attribution (+evidence) · metric        │
│ registry · rollups · reports                        [AnalyticsQueryPort]                          │
└───────────────────────────────────┬───────────────────────────────────────────────────────────────┘
                                     │ facts + attributed outcomes
                                     ▼
┌────────────────────────────────── intelligence ───────────────────────────────────────────────────┐
│ knowledge graph · feature store · retrieval · capabilities · recommendation engine                │
│ execution: prompt registry · model router · budgets · provenance · evaluation                     │
│                          [IntelligencePort] ──▶ [ModelProviderPort] ──▶ provider adapters         │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Ten business modules:** identity · organization · billing · social · marketing · crm ·
marketplace · analytics · intelligence *(+ automation as a platform package, since it is
infrastructure used by all products rather than a product domain itself)*.

---

## 3. Updated dependency graph

Arrows point **from dependent to dependency**. Every module-to-module arrow is either a
`contracts` import or an event subscription — never a table read.

```
              apps/web    apps/api    apps/worker    apps/link
                  │           │            │             │
                  └───────────┴──────┬─────┴─────────────┘
                                     │  (contracts only — enforced by dependency-cruiser)
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
        intelligence ──────────▶ analytics ◀────────── (events from all)
              │                      │
              │  contracts           │  contracts
              ▼                      ▼
    ┌────────────────┬───────────────┬──────────────┬───────────────┐
    ▼                ▼               ▼              ▼               ▼
  social         marketing          crm        marketplace       billing
    │                │               │              │               │
    └────────────────┴───────┬───────┴──────────────┴───────────────┘
                             ▼
                       organization  ──▶  identity
                             │                │
                             └───────┬────────┘
                                     ▼
                              platform/* packages
                                     │
                                     ▼
                      integrations/core ──▶ integrations/<provider>
                                                    │
                                        meta-core ──┴── instagram · facebook · threads
```

**Acyclic by construction, verified in CI.** Three properties worth stating explicitly:

- **`analytics` depends on nothing above it.** It subscribes to events; no product module
  calls it synchronously. A slow report cannot slow a publish.
- **`intelligence` is the lowest consumer.** It reads analytics and other modules' contracts,
  and writes only proposals. A model provider outage cannot block any critical path.
- **`marketplace` sits beside the other products, not beneath them.** It depends on
  `platform/*` and `billing`'s money primitives — the same ones platform billing uses.

---

## 4. Updated implementation sequence

Full detail in [14-roadmap.md](14-roadmap.md); Phase 0 fully specified in
[18-phase-0-plan.md](18-phase-0-plan.md).

| Phase | Weeks | Delivers |
| --- | --- | --- |
| **0 — Foundation** | 2.5 | Workspace, boundary enforcement, DB harness, migration lint, design tokens, CI, staging deploy |
| **1 — Tenancy & access** | 5 | identity, org→team→workspace, three-scope RBAC, `client_guest`, RLS + 4 isolation suites, dual onboarding, audit, entitlements, app shell |
| **2 — Spine, integrations, money, AI platform** | 6 | Outbox, jobs, integration core, `meta-core`, billing, **double-entry ledger**, **AI platform** (router, prompts, budgets, provenance, evals), marketplace contracts |
| **3 — Social Growth OS** | 9 | Tier 1 platforms, content, calendar, client approvals, publishing, inbox, listening, metrics, AI generation |
| **3.5 — Tier 2 platforms** | 2 | X, Pinterest, Threads — *a deliberate test of the provider abstraction* |
| **4 — Marketing OS + attribution spine** | 8 | Campaigns, `apps/link` + tracked links, landing pages, forms, CRM, email, ad ingestion, identity graph, touchpoints, AI research/trends |
| **5 — Automation engine** | 4.5 | Triggers, branching, delays, waits, intelligence nodes, builder, run inspector |
| **6 — Analytics + intelligence grounding** | 6 | Attribution models with evidence, metric registry, rollups, dashboards, per-client reporting, knowledge graph, feature store, lead scoring |
| **7 — Marketplace** | 9 | Catalogue, Connect onboarding, discovery, orders, fulfilment, payouts, reviews, disputes, provisioning |
| **8 — Recommendation engine** | 5 | Cross-product detectors, ranking, lifecycle, measured impact |
| **9 — Enterprise & public platform** | 5 | Public API, outbound webhooks, SSO/SCIM, access reviews, pen test |
| **10 — Scale hardening** | cont. | Replicas, partition automation, load testing, conditional ClickHouse |

**~60 weeks on the critical path; ~46 to a complete Social Growth OS.** Three parallel
streams open from Phase 3 (Social · Marketing+CRM+attribution · Automation+Marketplace),
joining at Phase 6.

```
 P0 ─▶ P1 ─▶ P2 ─┬─▶ P3 ──▶ P3.5 ─┐
                 ├─▶ P4 ───────────┼─▶ P6 ─┬─▶ P8 ─▶ P9 ─▶ P10
                 ├─▶ P5 ───────────┘       │
                 └─▶ P7 ───────────────────┘
```

---

## 5. Remaining blocking decisions

**None blocks Phase 0.** Each has a documented working assumption I will proceed on unless
told otherwise. Detail in [15-risks.md](15-risks.md) §3.

| # | Question | Working assumption | Blocks from |
| --- | --- | --- | --- |
| 1 | Jurisdictions and compliance at launch | GDPR-ready from Phase 1; `data_region` present but unused; SOC 2 evidence continuous, audit post-GA | Phase 1 |
| 2 | AI commercial model | Metered credits per plan with overage, attributed per workspace so agencies can bill clients | Phase 2 |
| 3 | Marketplace merchant of record | Sellers as merchants via Stripe Connect; we take commission | Phase 2 |
| 4 | Team size and shape | Three parallel streams available from Phase 3 | Phase 3 |
| 5 | Model provider preference / residency constraint | Anthropic first adapter; router multi-provider from day one; per-tenant allowlist | Phase 2 |

Question 1 is the one I would most like answered early: residency and consent design touch
Phase 1 schema, and they are cheaper to design in than to retrofit.

---

## 6. Risks introduced by these decisions

Five new, four changed. Full detail in [15-risks.md](15-risks.md) §1.

| Risk | Source decision | Severity | Principal mitigation |
| --- | --- | --- | --- |
| **AI cost unpredictability** *(new)* | 4, 8 | High probability, medium impact | Pre-invocation budget checks with hard stops; per-workspace attribution; response caching; anomalous-spend circuit breaker |
| **AI output quality / hallucination** *(new)* | 4 | High probability, medium impact | Citations required with low-grounding answers withheld; schema validation; proposals not unattended writes; golden-set evals gate every prompt change |
| **Prompt injection via ingested content** *(new)* | 4 | Medium / medium | Untrusted text delimited, never granted instruction authority; tool use disabled for those capabilities |
| **Three-level hierarchy complexity** *(new)* | 2 | Medium / medium | Teams excluded from the RLS predicate; generated authz matrix expands to all three scopes automatically |
| **Recommendation engine produces unmeasured advice** *(new)* | 8 | Medium / medium | `expected_impact` recorded at creation, measured after application; detectors demoted on underperformance |
| **Scope and duration** *(changed)* | all | High / high | +12 weeks vs. original. Lever if timelines compress is fewer Tier 1 platforms, not thinner architecture |
| **Cross-tenant leak** *(changed — stakes raised)* | 2 | Low / catastrophic | Agency leak = leak between a customer's clients. `client_guest` gets its own suite; retrieval filtered by workspace *before* ranking |
| **Provider instability** *(changed — 8 platforms)* | 3 | Certain / medium | `meta-core` fixes Meta changes once; manifests degrade capabilities rather than erroring. **Tier 1 app review must start in Phase 1** |
| **Attribution defensibility** *(changed)* | 6 | Medium / high | Model, version, lookback and evidence stored per result; `attribution_computations` explains restatements |
| **Operational load** *(changed)* | 4, 7 | Medium / medium | Managed services; k8s/mesh/warehouse deferred with named triggers; runbook required per paging alert |

### The one action that cannot wait

**Tier 1 platform app review (Instagram, Facebook, YouTube, LinkedIn, TikTok) must be
initiated during Phase 1.** Review is calendar time we cannot compress or parallelise, some
of these platforms require a working demo and a privacy policy before granting production
scopes, and a rejection can cost weeks. It is the single most likely cause of a launch-date
surprise, and it is the one item on this list that is not gated on engineering progress.

---

## 7. Status

Architecture approved. Phase 0 plan specified in [18-phase-0-plan.md](18-phase-0-plan.md).
**Awaiting approval to begin structural implementation.**
