# 15 — Risks, Trade-offs & Open Questions

## 1. Ranked risks

Ranked by expected cost (probability × blast radius), not by likelihood alone.

### R1 — Scope is very large relative to any realistic team *(high probability, high impact)*
Three products, each individually a company. The realistic failure is not bad architecture;
it is running out of runway with three half-built products.
**Mitigation:** the phase order is a genuine dependency order, and every phase ends in
something shippable. Phases 0–4 constitute a coherent, sellable product (Social + Marketing
+ attribution) without Marketplace. Marketplace (Phase 7) is the largest deferrable unit and
should be re-justified commercially before it starts.
**Decision needed from you:** which product must be revenue-generating first. That answer
can reorder Phases 3, 4 and 7 — the architecture supports any order.

### R2 — Cross-tenant data leak *(low probability, catastrophic impact)*
A single missed authorization check in a B2B product ends customer trust permanently.
**Mitigation:** three independent layers ([06](06-identity-and-access.md)); RLS as an
unbypassable backstop; four *structural* CI tests that fail when a new table lacks a policy —
so the control does not depend on anyone remembering. This is the reason RLS is
non-negotiable despite its query-planning cost.
**Residual:** RLS adds overhead on hot paths. Accepted; measured; mitigated with
tenant-leading indexes.

### R3 — Provider API instability *(certain, medium impact)*
Social and ad platforms change terms, deprecate endpoints, and revoke app access —
sometimes with little notice. This is not a hypothetical; it is the operating environment.
**Mitigation:** ports and adapters confine each change to one package; the capability
manifest means an ability that disappears degrades the UI rather than breaking it; contract
tests detect drift; the normalized error taxonomy means the core needs no change.
**Residual:** losing platform access entirely is a business risk no architecture can absorb.
Mitigate commercially by not depending on any single platform.

### R4 — Attribution correctness *(medium probability, high impact)*
Attribution numbers that customers cannot reproduce or trust destroy the product's core
claim faster than missing features do.
**Mitigation:** stored per-model results; lookback windows stamped onto results;
drill-through to source rows on every number; a single metric registry; incremental rollups
proven equal to a full rebuild.
**Residual:** identity resolution is inherently imperfect (shared devices, privacy
browsers, dark social). Mitigate by presenting confidence and coverage honestly rather than
implying precision we do not have.

### R5 — Publishing reliability *(medium probability, high impact)*
A missed or duplicated post is immediately visible to the customer's own audience.
**Mitigation:** claim-based dispatch with `SKIP LOCKED`, idempotency keys persisted before
the provider call, reconciliation against provider state, punctuality as a tracked SLO with
its own alert, DST-correct scheduling.

### R6 — Drizzle ORM is pre-1.0 *(medium probability, medium impact)*
A breaking change or project stall in a core dependency.
**Mitigation:** Drizzle is confined to `infrastructure/` repositories; no Drizzle type
appears in a domain, contract or application signature; migrations are plain SQL and
unaffected. Replacement would be mechanical and bounded.

### R7 — TypeScript 7 is a new compiler line *(medium probability, low impact)*
**Mitigation:** no 7-only syntax is used; CI typechecks against the 6.x line in parallel for
the first two months; reverting is a one-line change.

### R8 — Modular monolith erodes into a big ball of mud *(medium probability, high impact)*
Boundary discipline decays under deadline pressure — this is the normal fate of modular
monoliths, and assuming it will not happen here is the mistake.
**Mitigation:** boundaries are mechanically enforced by four independent means
([03](03-repository-structure.md) §2) rather than by convention or review vigilance. An
architecture violation is a red build, not a code-review conversation.

### R9 — Marketplace money handling *(low probability, high impact)*
Payout and commission errors are legally and commercially serious.
**Mitigation:** Stripe Connect owns KYC, payouts and compliance; a double-entry ledger makes
reconciliation exact; property-based tests over randomised order/refund/payout sequences;
amounts always resolved server-side from the listing.

### R10 — Operational load exceeds the team *(medium probability, medium impact)*
Postgres, Redis, queues, workers, providers, Stripe, storage — a real surface to operate.
**Mitigation:** managed services throughout; deliberately deferring Kubernetes, service mesh
and a warehouse; every paging alert requires a runbook or it is deleted.

### R11 — Analytics volume outgrows Postgres *(medium probability, medium impact)*
**Mitigation:** partitioning and rollups from day one; the `AnalyticsQueryPort` makes
ClickHouse a swap; thresholds are measured, not guessed.

### R12 — The public repository leaks something *(low probability, high impact)*
**Mitigation:** gitleaks pre-commit and in CI, GitHub push protection, a registered key
format, and `.gitignore` written before any application code.

## 2. Principal trade-offs, stated plainly

| Decision | Chosen | Given up | Why the trade is right here |
| --- | --- | --- | --- |
| Modular monolith | Transactional integrity, cheap cross-product joins, one deploy | Independent per-service scaling and deploys | The product's value *is* the cross-product join. Distributing it first would make the core feature hard and slow |
| Shared schema + RLS | Cheap cross-tenant analytics, one migration path, strong isolation | Per-tenant physical isolation; some query-plan overhead | Isolation is achieved without paying migration cost per customer |
| Sessions over JWTs | Immediate revocation, no refresh complexity | A session-store lookup per request | Revocation is a security requirement in B2B; the lookup is cheap and cacheable |
| Own automation engine | Fits user-authored workflows; full inspectability | Temporal's battle-tested durability | Workflows are user data, not code; the executor interface keeps Temporal available later |
| Drizzle over Prisma | RLS, partitioning, complex SQL, reviewable migrations | Prisma's maturity and tooling | Our hardest requirements are exactly where Prisma is weakest |
| Postgres-only analytics initially | One datastore, one language, no dual-write | Sub-second queries over billions of rows | A second datastore before the volume exists costs more than it saves; the port makes it swappable |
| Own design system | A distinctive, dense, professional product | Weeks of component work | The directive requires it, and a template look is a competitive liability in enterprise sales |
| REST + Server Actions, no GraphQL | Simple authorization, explicit performance | Client-driven query flexibility | Authorization on a graph is materially harder to make correct, and correctness is the priority |

## 3. Open questions — I need your answers before Phase 1

These are the decisions where proceeding on an assumption would produce work that must be
redone. Everything else I can decide and document.

1. **Which product ships first commercially?** Social, Marketing, or Marketplace? The
   architecture supports any order; the phase plan currently assumes Social → Marketing →
   Marketplace.
2. **Who is the primary customer — a single business, or an agency managing many clients?**
   The architecture supports both (organization + workspace), but it changes onboarding,
   pricing, permissions defaults and navigation emphasis significantly.
3. **Which social and ad platforms are required for launch?** Adapter effort varies by more
   than 3× between platforms, and some require app review that takes weeks of calendar time
   and must be started early.
4. **Which jurisdictions and compliance obligations at launch?** EU residency, GDPR posture
   and SOC 2 timing all affect Phase 1 decisions, not later ones.
5. **Marketplace money flow:** are we merchant of record, or is Stripe Connect with sellers
   as merchants acceptable? This determines tax, liability and the ledger model.
6. **Team size and shape.** The phase estimates assume a small senior team; the parallel
   plan from Phase 3 assumes at least three streams.
7. **Deployment target preference?** The design is deliberately portable (containers,
   managed Postgres/Redis). If there is an existing cloud commitment or vendor preference,
   Terraform modules should be written for it from Phase 0.
8. **AI features:** in scope for v1 (content generation, listening summarisation, lead
   scoring)? The `LlmPort` exists regardless, but material scope changes Phase 3–4 sizing.

## 4. What I recommend you decide right now

Only three answers block Phase 0 from starting: **(1)** the first commercial product,
**(2)** single-business vs agency as the primary customer, and **(7)** the deployment
target. The rest can be answered during Phase 0 without rework.

## 5. Explicitly out of scope for this proposal

Pricing and packaging, go-to-market, brand identity and visual direction beyond the design
system's structural rules, content strategy, and any commitment to specific launch dates.
