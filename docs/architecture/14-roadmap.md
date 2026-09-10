# 14 — Development Phases

## Sequencing principle

Phases are ordered by **irreversibility**, not by visibility. Tenancy, the event spine and
the attribution model are the decisions that cannot be cheaply changed once real customer
data exists; they come first even though they demo poorly. Features that are expensive but
reversible come later.

Every phase produces **production-quality, tested, documented, deployable** code. No phase
produces scaffolding to be replaced. There is no throwaway increment.

Durations are engineering estimates for a small senior team and should be re-based against
actual team size at approval.

---

## Phase 0 — Foundation *(~2 weeks)*
**Goal:** a repository where correct code is the path of least resistance.

- pnpm workspace + Turborepo; `apps/*` and `packages/*` skeletons with real boundaries.
- `packages/platform/{config,types,errors,logger,telemetry}`.
- Database harness: `initdb`-based cluster, template cloning, transaction rollback.
- Migration tooling + the migration lint rules from [05](05-data-architecture.md) §11.
- Design tokens, theming, first primitives, Storybook.
- CI: static → security → unit → integration → build → E2E; preview deploys.
- Terraform skeleton for staging; container build; health endpoints.
- `SECURITY.md`, `CONTRIBUTING.md`, ADR process, `.gitignore`, gitleaks pre-commit.

**Exit:** a trivial endpoint is deployable to staging through the full pipeline, and CI
already fails on a boundary violation, a missing RLS policy and a committed secret.

---

## Phase 1 — Tenancy & access *(~4 weeks)*
**Goal:** the security model, complete and provably correct.

- `identity`: users, sessions, password (Argon2id), email verification, MFA (TOTP),
  OAuth login, device management.
- `organization`: orgs, workspaces, teams, memberships, invitations, roles, permissions,
  resource grants, API keys, settings.
- `platform/authz` policy engine; the full permission catalogue.
- **RLS on every tenant table**, plus all four structural isolation tests.
- `platform/audit` (hash-chained), `platform/entitlements` (check surface, plan data),
  `platform/notifications`, `platform/files`, `platform/i18n`.
- App shell, navigation, command palette, settings, dark/light themes.

**Exit:** the authorization matrix and cross-tenant probe suites pass at 100%, a full
onboarding E2E passes, and an external reviewer can read `db/policies/` and verify isolation.

---

## Phase 2 — Event spine, jobs & integration core *(~4 weeks)*
**Goal:** the machinery every product feature will depend on.

- `platform/events`: registry, outbox, relay, typed bus, versioning rules.
- `platform/jobs`: BullMQ adapter, in-memory fake, idempotency, retry, DLQ, `job_executions`.
- `integrations/core`: ports, provider registry, capability manifests, credential vault
  (envelope encryption + rotation), OAuth lifecycle, rate limiter, circuit breaker,
  normalized error taxonomy, webhook receiver + verification, `sync_cursors`.
- `integrations/testkit`: the shared adapter contract suite.
- `billing`: plans, Stripe Billing subscriptions, invoices, usage metering, dunning.
- Admin surfaces: queue health, DLQ inspection/replay, connection health.

**Exit:** one real provider connects end to end; token refresh, rate limiting, circuit
breaking, webhook replay and DLQ replay are each demonstrated by test and by drill.

---

## Phase 3 — Social Growth OS *(~7 weeks)*
- Social accounts; first providers (LinkedIn, Meta, X, TikTok, YouTube).
- Content items and per-platform variants; media library; manifest-driven composer
  validation.
- Calendar, planning, content pillars.
- Approval workflows and collaboration (comments, assignment, review states).
- Publishing: scheduling with timezone/DST correctness, claim-based dispatch, idempotent
  publish, attempts, retries, reconciliation.
- Unified inbox: comments, DMs, mentions; assignment, saved replies, SLA timers.
- Listening monitors and competitor tracking.
- Metric ingestion (upsert-by-grain) and per-post/account performance views.

**Exit:** a post scheduled for 09:00 local publishes within the punctuality SLO across a DST
boundary, and a provider outage during publish degrades visibly and recovers without
duplicates.

---

## Phase 4 — Marketing OS core & the attribution spine *(~7 weeks)*
- Strategy: positioning, ICPs, segments, offers, research.
- **Campaigns** — the cross-product spine.
- **Tracked links + the redirect service** — the social→revenue bridge, and the piece the
  whole analytics promise depends on.
- Landing pages, forms, lead capture; consent handling.
- `crm`: contacts, companies, deals, pipelines, activities, custom fields, scoring,
  assignment.
- Email/messaging sends and sequences; follow-up cadences.
- Ad accounts and ad-platform ingestion, including `ad_spend_facts` (real cost data — CPL and
  CAC are not estimates).
- `analytics` foundations: identity graph, touchpoints, conversions, cost facts.

**Exit:** the end-to-end chain test passes — a published social post produces a click, a
lead, a qualified contact, a won deal, and revenue attributed back to that post.

---

## Phase 5 — Automation engine *(~4 weeks)*
- Definitions, immutable versions, triggers (event / schedule / webhook / manual).
- Runtime: conditions, branching, delays, waits, parallel, bounded loops, sub-automations.
- Idempotent steps, retry policies, timeouts, recursion guard, per-plan limits.
- Visual builder; run inspector with per-node inputs, outputs and timing; cancel, retry from
  step, replay.

**Exit:** chaos drills (worker killed mid-run, Redis down, provider rate-limited) produce the
documented behaviour, and a run's full history is explicable from the UI.

---

## Phase 6 — Analytics, attribution & reporting *(~5 weeks)*
- Attribution models with configurable, result-stamped lookback windows.
- Metric registry; incremental rollups; the `AnalyticsQueryPort`.
- Dashboards, report builder, drill-through to source rows, scheduled exports.
- Funnel, cohort and campaign ROI views; social→revenue reporting.

**Exit:** every headline number drills to its rows; incremental rollups equal a full rebuild
(property test); reports meet their latency SLO on scale fixtures.

---

## Phase 7 — Marketplace *(~8 weeks)*
- Listing types, categories, attribute definitions/values (new categories without migrations).
- Seller onboarding and verification via Stripe Connect; seller and buyer profiles.
- Search, facets, ranking, discovery.
- Cart, orders, fulfilment, digital delivery, entitlement provisioning.
- Payments, refunds, commissions, payouts, **double-entry ledger** and reconciliation.
- Reviews (order-verified), moderation queue, disputes.
- Cross-product provisioning: purchasing a campaign template instantiates a real campaign.

**Exit:** the ledger balances to zero across randomised order/refund/payout sequences
(property test); Stripe reconciliation is exact; the marketplace-specific security suite
passes.

---

## Phase 8 — Enterprise & public platform *(~5 weeks)*
- Public REST API v1 with generated OpenAPI, API-key scopes and per-key rate limits.
- Outbound webhooks with signing, retries and rotation.
- SAML/OIDC SSO and SCIM provisioning behind `EnterpriseIdentityPort`.
- Custom roles UI, access reviews, session policy, org-wide MFA enforcement.
- Data export/erasure workflows; residency routing.
- External penetration test; SOC 2 readiness evidence.

---

## Phase 9 — Scale hardening *(continuous from Phase 6)*
- Read replicas and explicit read routing; PgBouncer tuning.
- Partition automation, archival to Parquet, retention verification.
- Load testing at 10× projected volume; N+1 and query-budget enforcement.
- ClickHouse behind `AnalyticsQueryPort` **only if** measured thresholds are crossed.
- Extract a module to its own service **only if** its load profile genuinely diverges.

---

## Parallelisation

Phases 0–2 are strictly sequential — everything else depends on them. From Phase 3 the work
splits cleanly along module boundaries:

```
   Phase 3 (social)  ─┐
   Phase 4 (marketing/crm)  ─┼─▶ Phase 6 (analytics)  ─▶ Phase 8/9
   Phase 5 (automation)  ─┘
   Phase 7 (marketplace)  ──────────────────────────────▶
```

That the modules can be built by separate people without collision is the practical payoff
of the boundary discipline in [03](03-repository-structure.md) — the architecture is what makes
the plan parallelisable.

## Definition of done (every phase, no exceptions)

Typed with no `any` · authorization asserted and tested · RLS present and probed · domain
events emitted transactionally · jobs idempotent · failure modes documented and drilled ·
observability instrumented with alerts and runbooks · tests at every relevant level with
coverage gates met · accessibility verified · documentation and ADRs updated · migrations
expand/contract and reviewed · deployed to staging and soaked.
