# 15 — Risks, Trade-offs & Open Questions

*Revised 2026-09-10 following approval of the strategic decisions. Risks introduced by those
decisions are marked **NEW**; risks whose profile changed are marked **CHANGED**.*

## 1. Ranked risks

Ranked by expected cost (probability × blast radius).

### R1 — Scope and duration *(high probability, high impact)* — **CHANGED**
Three products, an intelligence layer, eight social platforms and an agency-grade permission
model. The approved decisions add roughly 12 weeks to the critical path versus the original
plan (AI platform, ledger and Meta core moved earlier; team layer; Tier 2 platforms;
recommendation engine).

I raised scope as a concern before approval and you reaffirmed the full scope. That is your
call and I am building to it — this entry exists to keep the number visible, not to reopen
the decision. **~60 engineering weeks on the critical path, ~46 to a complete Social Growth
OS.**

**Mitigation:** the phase order is a genuine dependency order; three parallel streams open
from Phase 3; each phase ends deployable. The honest lever if timelines compress is *fewer
Tier 1 platforms at launch*, not thinner architecture — three platforms done properly beats
five done shallowly, and the abstraction means adding the others later is cheap.

### R2 — Cross-tenant data leak *(low probability, catastrophic impact)* — **CHANGED**
The agency model raises the stakes: a leak between two workspaces is a leak between two of
your customer's *clients*, which is a breach of their commercial confidence, not just ours.
The `client_guest` role puts a person outside the tenant organization inside the product.
**Mitigation:** three independent layers; RLS as an unbypassable backstop; four structural
CI tests; `client_guest` gets its own dedicated authorization suite; retrieval in the
intelligence layer is filtered by workspace *before* ranking, never after.

### R3 — Three-level hierarchy complexity *(medium probability, medium impact)* — **NEW**
Organization → team → workspace with three role scopes plus resource grants is materially
more permission surface than two levels. Complexity in authorization is where subtle bugs
live.
**Mitigation:** teams deliberately do **not** enter the RLS predicate — they resolve in the
application layer into an accessible-workspace set ([ADR-0003](../adr/0003-tenancy-model.md)).
The database boundary stays two-level and simple. The generated authorization matrix expands
to cover all three scopes automatically, so coverage grows with the model rather than
lagging it.
**Residual:** UI complexity for direct businesses that have no use for teams. Mitigated by
collapsing the team layer in the interface when it carries no information.

### R4 — AI cost unpredictability *(high probability, medium impact)* — **NEW**
Model spend scales with usage, not with seats. An agency generating content for forty
clients, or a runaway automation loop calling a model per iteration, can produce a bill
nobody forecast. This is the most likely way AI hurts us commercially.
**Mitigation:** `ai_budgets` per organization and workspace checked **before** invocation
with hard stops; per-capability cost classes; automation intelligence nodes check budget
before running; response caching on `(prompt_version, input_hash, model)`; spend attributed
per workspace so an agency can see cost per client; anomalous-spend circuit breaker that
trips before the bill, not after it.
**Residual:** margin risk if pricing does not track cost. That is a commercial decision — see
§3, question 2.

### R5 — AI output quality and hallucination *(high probability, medium impact)* — **NEW**
A confidently wrong competitor summary or a fabricated statistic in client-facing content is
a reputational problem for the agency using our product, which makes it our problem.
**Mitigation:** citations required for research, explanation and trend capabilities, with
low-grounding answers withheld rather than shown; structured outputs schema-validated;
AI content labelled until human-approved; **AI emits proposals, never unattended domain
writes**; golden-set evaluations gate every prompt and model change in CI.
**Residual:** generation is inherently probabilistic. The design keeps a human between the
model and anything published.

### R6 — Prompt injection through ingested content *(medium probability, medium impact)* — **NEW**
We ingest untrusted text by design: inbound social messages, comments, competitor pages,
marketplace listings. Any of it can attempt to redirect a model that reads it.
**Mitigation:** untrusted content is delimited and never granted instruction authority; tool
use is disabled for capabilities that read untrusted input; outputs are schema-constrained;
no capability that reads untrusted text may write to the domain.

### R7 — Provider API instability *(certain, medium impact)* — **CHANGED**
Eight social platforms rather than five, plus model providers. Platform terms, endpoints and
app-review outcomes change with little notice.
**Mitigation:** ports and adapters confine each change to one package; capability manifests
turn a withdrawn capability into a disabled control rather than a runtime error; contract
tests detect drift; `meta-core` means one Meta change is fixed once, not three times.
**Residual:** losing platform access entirely is a business risk no architecture absorbs.
**Action required now:** Tier 1 app review for Instagram, Facebook, YouTube, LinkedIn and
TikTok must start in Phase 1 — review is calendar time we cannot compress, and it is the
most likely source of a launch-date surprise.

### R8 — Attribution correctness and defensibility *(medium probability, high impact)* — **CHANGED**
Agencies present these numbers to paying clients, who will challenge them. A number that
cannot be defended is worse than no number.
**Mitigation:** model, version, lookback window and **source evidence** stored on every
result; `attribution_computations` records what produced a restatement; drill-through to
source rows; credit fractions property-tested to sum to 1.0.
**Residual:** identity resolution is inherently imperfect. Present coverage and confidence
honestly rather than implying precision we do not have.

### R9 — Modular monolith erodes *(medium probability, high impact)*
Boundary discipline decays under deadline pressure. Now with ten modules rather than eight.
**Mitigation:** four independent mechanical enforcement mechanisms. An architecture violation
is a red build, not a review conversation.

### R10 — Publishing reliability *(medium probability, high impact)*
A missed or duplicated post is immediately visible to the customer's client's audience.
**Mitigation:** claim-based dispatch with `SKIP LOCKED`; idempotency keys persisted before
the provider call; reconciliation against provider state; punctuality as a tracked SLO.

### R11 — Marketplace money handling *(low probability, high impact)*
**Mitigation:** Stripe Connect owns KYC and payouts; double-entry ledger built in Phase 2 and
exercised by platform billing for five phases before marketplace traffic touches it — by the
time it handles marketplace money it is proven code; nightly balance assertion pages on a
non-zero result.

### R12 — Drizzle ORM pre-1.0 *(medium probability, medium impact)*
**Mitigation:** confined to `infrastructure/`; no Drizzle type in any domain, contract or
application signature; migrations are plain SQL and unaffected.

### R13 — Operational load exceeds the team *(medium probability, medium impact)* — **CHANGED**
Now also model providers, vector indexes, AI budgets and marketplace payouts.
**Mitigation:** managed services throughout; Kubernetes, service mesh and a warehouse
explicitly deferred with named triggers ([12](12-devops-architecture.md) §9); every paging
alert requires a runbook or it is deleted.

### R14 — TypeScript 7 compiler line *(medium probability, low impact)*
**Mitigation:** no 7-only syntax; CI typechecks against 6.x in parallel for two months.

### R15 — Public repository leak *(low probability, high impact)*
**Mitigation:** gitleaks pre-commit and CI, GitHub push protection, registered key format,
`.gitignore` before any application code. Model provider keys join the same regime.

## 2. New trade-offs from these decisions

| Decision | Chosen | Given up | Why the trade is right |
| --- | --- | --- | --- |
| Teams outside the RLS predicate | Simple two-level policies; teams free to grow in expressiveness | A single uniform mechanism for all three levels | A three-way join in every policy on every query is a permanent tax, and it breaks when a workspace is served by two teams |
| AI platform in Phase 2, capabilities later | The governance, budget, provenance and evaluation machinery exists before the first capability | Faster time to a visible AI feature | Retrofitting cost control and provenance onto shipped AI features is how products end up with unattributable spend and unexplainable output |
| Ledger in Phase 2, marketplace in Phase 7 | The ledger is proven by five phases of billing traffic before marketplace money touches it | Some Phase 2 work with no immediate marketplace payoff | Introducing double-entry after a year of mutable balances means reconstructing history that was never recorded |
| Meta core + three adapters | One credential, one rate-limit budget, three honest capability sets | The simplicity of one Meta adapter | Meta meters the app, not the surface — triple-counting the budget is wrong, not just wasteful |
| Tier 2 as a separate phase | A real test of the provider abstraction | Shipping all eight platforms together | If adding Pinterest requires editing core code, we need to know while it is cheap to fix |
| Recommendations in Phase 8 | Grounded in the tenant's own attributed outcomes | Early demo appeal of an AI recommendations panel | Recommendations built before attribution exists are generic advice, which is the failure mode this layer exists to avoid |

## 3. Remaining blocking decisions

Three of the original eight were answered by your decisions (commercial order, primary
customer, deployment). Five remain. **None blocks Phase 0** — I have taken a documented
default position on each and will proceed unless you say otherwise.

| # | Question | My working assumption | When it becomes blocking |
| --- | --- | --- | --- |
| 1 | **Jurisdictions and compliance at launch?** GDPR posture, EU residency, SOC 2 timing | GDPR-ready from Phase 1 (erasure, export, consent, `data_region` column present but unused); SOC 2 evidence gathered continuously, audit post-GA | **Phase 1** — residency and consent design |
| 2 | **AI commercial model?** Credits included per plan, metered overage, or bundled | Metered credits per plan with overage, tracked per workspace so agencies can attribute cost to clients | **Phase 2** — meter shape must exist before the budget guard is built |
| 3 | **Marketplace merchant of record?** Us, or sellers via Stripe Connect | Sellers as merchants via Connect; we take commission. Lower tax and liability exposure | **Phase 2** — determines the ledger's account structure |
| 4 | **Team size and shape?** | Three parallel streams from Phase 3 | **Phase 3** — the parallel plan assumes it |
| 5 | **Model provider preference or constraint?** Anthropic-first, multi-provider from the start, or a data-residency constraint on model calls | Anthropic as the first adapter, router built multi-provider from day one, per-tenant allowlist supported | **Phase 2** — first adapter choice (cheap to change; the port is the commitment) |

## 4. Explicitly out of scope

Pricing and packaging, go-to-market, brand identity and visual direction beyond the design
system's structural rules, content strategy, and any commitment to calendar dates.
