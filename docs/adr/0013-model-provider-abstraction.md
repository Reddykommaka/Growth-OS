# ADR-0013 — Multi-provider model abstraction; no provider SDK in product code

**Status:** Accepted · **Date:** 2026-09-10 · **Approved:** 2026-09-10

## Context
AI is in scope for the production product across ten capability categories. Model providers
differ in pricing, latency, context window, structured-output support, tool use and
availability, and the competitive landscape moves faster than our release cycle. Some
tenants will impose residency or vendor constraints on model calls.

## Decision
Product code depends on `IntelligencePort`. The intelligence layer depends on
`ModelProviderPort`. Provider SDKs (`@anthropic-ai/sdk`, `openai`, and any future peer) may
be imported **only** inside `packages/integrations/<provider>`, enforced by lint.

Model selection is made per invocation by a **router** reading a declarative policy —
capability, quality tier, latency budget, cost ceiling, tenant allowlist and residency —
never a hard-coded model constant. Fallback is a ranked list per capability, and any
failover is recorded on the invocation.

## Alternatives considered
- **Call a provider SDK directly from features.** Rejected: model choice becomes a code
  change in N call sites; cost, provenance and evaluation have nowhere to live; tenant-level
  model constraints become impossible.
- **A third-party LLM gateway/framework as the abstraction.** Rejected as the primary
  boundary: it is a dependency on someone else's abstraction of a fast-moving space, and our
  routing needs (per-tenant allowlist, per-workspace budget, capability-scoped policy) are
  product-specific. A gateway may later sit *behind* our port.
- **Single provider, swap if needed.** Rejected: "we'll abstract it later" means abstracting
  after the coupling has spread through the product, which is precisely when it is most
  expensive.

## Consequences
**Positive:** model and provider choice is configuration with a recorded evaluation; cost,
provenance and evals have exactly one place to live; tenant-level constraints are
enforceable; a provider outage fails over rather than failing.

**Negative:** an indirection layer between features and models; the port must expose the
union of capabilities we care about without becoming a lowest-common-denominator interface
that wastes what the best models can do. Mitigated by a per-model capability manifest, so a
caller can require a capability rather than assume it.
