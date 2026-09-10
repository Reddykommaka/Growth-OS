# ADR-0016 — AI governance: provenance, proposals, budgets and evaluation

**Status:** Accepted · **Date:** 2026-09-10 · **Approved:** 2026-09-10

## Context
AI features are being built into a product that publishes on customers' behalf, advises on
budget allocation, and — for agency customers — produces output shown to *their* clients.
Cost scales with usage rather than with seats. Model output is probabilistic. Some inputs
(inbound social messages, competitor pages, marketplace listings) are untrusted by nature.

## Decision
Four non-negotiable controls, built into the intelligence layer before any capability ships:

1. **Provenance on every invocation.** Capability, prompt version, provider, model, input
   hash, grounding reference, tokens, cost, latency and actor are persisted. There is no
   unlogged path to a model.
2. **Proposals, not unattended writes.** Intelligence emits proposals. Applying one is a
   normal domain write through the owning module's service, with normal authorization and
   audit. Auto-apply is opt-in per automation node, gated by its own permission
   (`intelligence.action:auto_apply`), and always audited with the invocation id.
3. **Budgets checked before invocation.** `ai_budgets` per organization and workspace, with
   soft warnings and hard stops. Automation intelligence nodes check budget before running.
   Spend is attributable per workspace, so an agency can see cost per client.
4. **Evaluation gates prompt and model changes.** Every capability has a golden set with
   assertions, run in CI. Prompts are versioned, immutable artefacts — code, not strings.

Plus: citations required for research/explanation/trend capabilities with low-grounding
answers withheld; structured outputs schema-validated; untrusted input delimited and never
granted instruction authority, with tool use disabled for capabilities that read it; AI
content labelled until human-approved.

## Alternatives considered
- **Ship capabilities first, add governance when it hurts.** Rejected: unattributable spend
  and unexplainable output are exactly the problems that cannot be reconstructed
  retroactively — the data needed to diagnose them was never recorded.
- **Prompts as inline strings.** Rejected: prompt changes then have no review, no version, no
  evaluation and no rollback, while changing output for every customer.
- **Trust model output into the domain directly.** Rejected: a hallucinated value written to
  a customer's CRM or a caption published unattended is a defect we cannot undo.

## Consequences
**Positive:** every AI output is explicable months later; cost is bounded and attributable;
prompt changes are reviewable and testable; a runaway automation cannot produce an unbounded
bill; the human stays between the model and anything published.

**Negative:** more machinery before the first visible AI feature; an invocation ledger row
per call (partitioned, and a fraction of the cost of the call itself); auto-apply is harder
to configure than "just do it", which is intentional friction on the one path where a
mistake is unrecoverable.
