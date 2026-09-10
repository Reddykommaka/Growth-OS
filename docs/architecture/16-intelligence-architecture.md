# 16 — AI & Intelligence Architecture

*Implements Decisions 4 (AI as a platform capability) and 8 (cross-product intelligence
layer).*

## 1. The distinction that governs this design

There are two different things here, and conflating them is the most common way AI features
become unmaintainable:

| | **AI capabilities** | **The intelligence layer** |
| --- | --- | --- |
| What it is | Discrete model-backed operations: generate a caption, summarise a thread, extract entities | A system that understands the relationships between a tenant's business, audience, content, campaigns, leads and revenue, and reasons over them |
| Input | A prompt plus some context | The knowledge graph, the feature store, and attributed outcomes |
| Output | Text or structured data | Recommendations with rationale, evidence and expected impact |
| Failure mode if done badly | Scattered SDK calls in components | Generic advice indistinguishable from a blog post |

Both are built. The capabilities are the *interface*; the intelligence layer is what makes
them worth using, because it is what makes an answer specific to *this* business.

## 2. Layered structure

```
   Product modules (social, marketing, crm, marketplace, analytics)
        │  depend on contracts only
        ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  packages/modules/intelligence                                           │
 │                                                                          │
 │  ┌─ Recommendation engine ──────────────────────────────────────────┐    │
 │  │  detectors · scoring · ranking · lifecycle · impact measurement   │    │
 │  └───────────────────────────────────────────────────────────────────┘    │
 │  ┌─ Capability layer ───────────────────────────────────────────────┐    │
 │  │  generation · transformation · research · trend analysis ·        │    │
 │  │  listening summarisation · campaign planning · lead scoring ·     │    │
 │  │  analytics explanation · workflow intelligence · recommendations  │    │
 │  └───────────────────────────────────────────────────────────────────┘    │
 │  ┌─ Grounding ───────────────────────────────────────────────────────┐    │
 │  │  knowledge graph · feature store · retrieval (pgvector + BM25) ·  │    │
 │  │  brand/voice context · attributed outcomes                        │    │
 │  └───────────────────────────────────────────────────────────────────┘    │
 │  ┌─ Execution ───────────────────────────────────────────────────────┐    │
 │  │  prompt registry · model router · cache · budget guard ·          │    │
 │  │  safety filters · schema validation · provenance recorder ·       │    │
 │  │  evaluation harness                                               │    │
 │  └───────────────────────────────────────────────────────────────────┘    │
 └────────────────────────────────┬─────────────────────────────────────────┘
                                  │ ModelProviderPort
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
  integrations/anthropic    integrations/openai      (future providers,
                                                      incl. self-hosted)
```

Product code calls `IntelligencePort` with a capability and a typed input. It never sees a
prompt, a model name, a token count or a provider. That single boundary is what keeps model
choice, prompt iteration and cost policy changeable without touching product code.

## 3. Provider abstraction

`ModelProviderPort` exposes `complete`, `completeStructured`, `stream`, `embed` and
`useTools`, with a normalized capability manifest per model (context window, modalities,
tool-use support, structured-output support, cost per million tokens, latency class).

**The model router** selects a model per invocation from a declarative policy — capability,
required quality tier, latency budget, cost ceiling, tenant's data-residency and
model-allowlist settings — rather than from a hard-coded constant. Policy is data, so
switching a capability from a large model to a smaller one is a configuration change with a
recorded evaluation, not a deployment of edited code.

Fallback is explicit: a ranked list per capability, with failover on `ProviderUnavailable`,
`RateLimited` or timeout. Failover is **recorded on the invocation**, because a silent
downgrade that changes output quality without anyone knowing is worse than a visible error.

**No product code may import a provider SDK.** Lint-enforced, as principle 13 in
[01](01-overview.md) §3. [ADR-0013](../adr/0013-model-provider-abstraction.md).

## 4. Grounding — where specificity comes from

An ungrounded model produces generic marketing advice. Four grounding sources make output
specific to the tenant:

**1. The knowledge graph** (`knowledge_nodes`, `knowledge_edges`) relates business, audience
segments, offers, content, campaigns, ads, channels, leads, customers, revenue and
marketplace listings. It is built incrementally by event subscribers — the same domain
events that feed analytics — so it is never a separate ingestion pipeline that can drift
out of sync. Edges carry weight and evidence, so "this content pillar drives pipeline" is a
traversable, explainable claim.

**2. The feature store** (`feature_snapshots`) holds point-in-time model inputs for scored
entities. Persisting features as they were *at scoring time* is what makes a score
reproducible and prevents training/serving skew — the defect where a model is trained on
values it will never see in production. It is cheap to build now and effectively impossible
to reconstruct later.

**3. Retrieval** over `content_embeddings` (pgvector, HNSW, tenant-scoped) combined with
Postgres full-text BM25 — hybrid, because pure vector search retrieves thematically similar
but factually wrong passages, and pure keyword search misses paraphrase. Retrieval is
**always filtered by workspace before ranking**, never after: a filter applied after
ranking is a cross-tenant leak waiting to happen, and in an agency tenant that means one
client's content surfacing in another client's suggestions.

**4. Attributed outcomes** from `analytics` — what actually produced pipeline and revenue
for this workspace, with evidence ([09](09-analytics-architecture.md) §9).

## 5. Capability catalogue

Each capability is a registry entry with a typed input/output schema, a prompt version, a
model policy, a required entitlement, a cost class and an evaluation set.

| Category | Capabilities |
| --- | --- |
| Content generation | Post drafts per platform, caption variants, hooks, hashtags, first comments, ad copy, email and landing-page copy — all constrained by the platform capability manifest ([07](07-integration-architecture.md) §1) so generated content is publishable by construction |
| Content transformation | Repurpose across platforms, resize/reframe messaging, tone and reading-level adjustment, translation, long-form → thread → short-form |
| Research | Audience and ICP synthesis, competitor positioning summaries, market briefs — each with cited sources |
| Trend analysis | Emerging topics from listening signals and competitor activity, scored for relevance to the workspace's pillars |
| Social listening | Thematic clustering, sentiment, intent detection, escalation triage across the unified inbox |
| Campaign planning | Objective → channel mix → content plan → budget split, grounded in this workspace's own historical performance |
| Lead scoring | Fit and intent scoring from CRM attributes plus touchpoint behaviour, from `feature_snapshots` |
| Analytics explanation | Narrative explanation of a metric movement, with the drill-down rows that support it |
| Workflow intelligence | Suggested automations from observed repeated manual actions; anomaly detection on automation runs |
| Recommendations | The cross-product engine — §6 |

## 6. The recommendation engine

Recommendations are **detected, scored, ranked and tracked** — not generated ad hoc when a
page loads.

```
 detectors (scheduled + event-triggered)
   → candidate recommendations, each with rationale, evidence, expected impact, confidence
     → dedupe + suppress (cooldowns, previously dismissed, not-entitled)
       → rank by expected impact × confidence × effort
         → surface in-product
           → applied / dismissed / expired
             → outcome measured against the prediction
```

Detectors span the products, which is the point of a cross-product layer:

| Recommendation | Detected from |
| --- | --- |
| Content optimisation | Post performance vs. pillar baseline; attributed pipeline per format and time slot |
| Campaign optimisation | Campaign metrics vs. objective, with attributed conversions |
| Budget recommendations | `cost_facts` + attributed revenue → CAC by channel, reallocation toward better-performing channels |
| Audience recommendations | Segment performance and identity-graph overlap |
| Lead prioritisation | Fit/intent scores plus touchpoint recency |
| Channel recommendations | Attributed ROI by channel vs. effort invested |
| Workflow recommendations | Repeated manual action sequences in the audit log |
| Marketplace recommendations | A detected capability gap matched to a listing (template, playbook, expert) |
| Revenue-growth opportunities | Funnel-stage drop-off, stalled deals, under-served segments |

**Every recommendation is measured.** `expected_impact` is recorded at creation; the outcome
is measured after application. A detector whose recommendations do not produce their
predicted effect is demoted or removed. Without this loop, a recommendation engine
accumulates plausible-sounding advice indefinitely and nobody can tell which parts work —
which is how these systems lose user trust and then usage.

## 7. Governance — the rules that make AI shippable

| Control | Implementation |
| --- | --- |
| **Provenance** | Every invocation records capability, prompt version, provider, model, input hash, grounding reference, tokens, cost, latency, actor. No exceptions, no unlogged path |
| **Human in the loop** | Intelligence emits *proposals*. Applying one is a normal domain write through the normal application service with the normal `authz.assert` and audit record. Auto-apply is opt-in per automation node and gated by its own permission |
| **Citations** | Research, explanation and trend capabilities must return sources. An answer that cannot cite is returned as "insufficient grounding" rather than as a confident fabrication |
| **Schema validation** | Structured outputs are Zod-parsed. A parse failure retries once with a repair prompt, then fails — malformed model output never reaches the domain |
| **Cost control** | `ai_budgets` per organization and workspace, checked before invocation, with soft warnings and hard stops. Per-capability cost classes; per-plan entitlements; spend attributable to workspace (i.e. to an agency's client) |
| **Caching** | Deterministic capabilities cache on `(prompt_version, input_hash, model)`. A meaningful share of generation traffic is repeat requests, and this is the cheapest available cost control |
| **Evaluation** | Every capability has a golden set with assertions. Prompt and model changes run the evals in CI and report a diff. A capability whose evals regress does not ship — prompts are code and are treated as such |
| **Safety** | Input and output filters; PII redaction before any provider call where the capability does not require it; prompt-injection defence for any capability that reads untrusted text (inbound social messages, competitor pages, marketplace listings) — untrusted content is delimited and never granted instruction authority |
| **Tenant data boundaries** | Retrieval filtered by workspace *before* ranking; no cross-tenant training; per-tenant model allowlist and residency settings honoured by the router; zero-retention provider endpoints where available |
| **Transparency** | AI-generated content is labelled in the UI until a human edits or approves it |

## 8. Failure modes

| Failure | Behaviour |
| --- | --- |
| Provider down or rate-limited | Router fails over to the next model in policy; failover recorded on the invocation. If all fail, the capability returns a typed error — the surrounding feature stays usable without AI |
| Model returns malformed structured output | Schema validation fails → one repair attempt → typed failure. Never written to the domain |
| Model returns a confident fabrication | Citations required for research/explanation; grounding coverage checked; low-coverage answers are withheld rather than shown |
| Budget exhausted | Soft threshold warns; hard stop refuses new invocations with an actionable message; running automations halt at the intelligence node rather than partially applying |
| Prompt-injection attempt in ingested content | Untrusted text is delimited and never granted instruction authority; tool use is disabled for capabilities that read untrusted input |
| Cost spike | Per-capability and per-org spend alerts; anomalous spend triggers a circuit breaker before the bill, not after it |
| Embedding model changed | Embeddings are versioned by model; a change triggers a scoped re-embed job; queries never mix embedding versions |
| Recommendation quality degrades | Applied-vs-predicted measurement demotes the detector; dismissal rate per detector is a monitored metric |
| Intelligence layer entirely unavailable | Every product surface degrades to its non-AI behaviour. **Nothing on a critical path depends on it** — this is enforced by the rule that no synchronous write path may call `IntelligencePort` |

## 9. Build sequence

The layer is built in dependency order, and deliberately not all at once:

1. **Phase 2** — `ModelProviderPort`, first adapter, prompt registry, invocation ledger,
   budget guard, cache, evaluation harness. The *platform*, with no product-facing capability.
2. **Phase 3** — generation and transformation for Social (the highest-value, lowest-risk
   capabilities), grounded in brand voice and platform manifests.
3. **Phase 4** — research, trend analysis, listening summarisation; embeddings and retrieval.
4. **Phase 6** — knowledge graph, feature store, lead scoring, analytics explanation.
   These require attribution to exist first; building them earlier would produce exactly the
   generic advice this design exists to avoid.
5. **Phase 7+** — the recommendation engine across all products, including marketplace
   matching, with impact measurement.
