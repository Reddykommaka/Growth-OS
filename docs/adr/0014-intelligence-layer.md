# ADR-0014 — A cross-product intelligence layer, not scattered AI calls

**Status:** Accepted · **Date:** 2026-09-10 · **Approved:** 2026-09-10

## Context
Growth OS must eventually reason about relationships between business, audience, offers,
content, social activity, campaigns, ads, leads, customers and revenue, and recommend
actions across all of them. The failure mode to avoid is AI as a decorative feature: a
"generate" button in each screen producing generic output indistinguishable from a blog post.

## Decision
Build `packages/modules/intelligence` as a platform capability with four layers:
**execution** (prompt registry, model router, cache, budget guard, safety, schema validation,
provenance, evaluation), **grounding** (knowledge graph, feature store, hybrid retrieval,
attributed outcomes), **capabilities** (the ten categories), and the **recommendation
engine** (detectors → scoring → ranking → lifecycle → measured impact).

Two invariants define its relationship to the rest of the system:
1. It **reads through other modules' contracts and analytics facts**, never their tables.
2. It **emits proposals, never direct domain writes.** Applying a recommendation is a normal
   write through the owning module's application service, with normal authorization and audit.

It is built in dependency order, with grounding-dependent capabilities deliberately after
attribution exists (Phase 6+), not before.

## Alternatives considered
- **AI features implemented per module.** Rejected: prompts, cost control, provenance,
  evaluation and safety would be duplicated or, more likely, absent in most of them; no
  module could see across products, which is the entire source of the useful insight.
- **A separate AI service from day one.** Rejected: it would need read access to every
  module's data, which either duplicates the data or breaks the boundaries this architecture
  exists to protect. The module can be extracted later through the event spine.
- **Recommendations generated on page load.** Rejected: unbounded cost, no dedupe, no
  cooldown, no lifecycle, and no way to measure whether any recommendation ever worked.

## Consequences
**Positive:** one place for prompts, cost, provenance, safety and evaluation; recommendations
grounded in the tenant's own measured outcomes rather than in generic priors; every
recommendation is tracked from prediction to measured result, so detectors that do not work
can be found and removed.

**Negative:** significant machinery before the first user-visible AI feature; the knowledge
graph and feature store are real ongoing cost; the layer is useless until attribution
exists, so its best capabilities arrive late. Accepted deliberately — the alternative is
shipping generic advice early and losing user trust in the feature permanently.
