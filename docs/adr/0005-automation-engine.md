# ADR-0005 — Data-driven automation engine rather than Temporal

**Status:** Accepted · **Date:** 2026-09-10 · **Approved:** 2026-09-10

## Context
End users author automations in a visual builder. Workflows must be versioned, paused,
resumed, inspected, audited, and safely edited while runs are in flight.

## Decision
Build a Postgres-backed engine where workflows are **data**: immutable `automation_versions`
holding a validated graph, advanced by workers as a persisted state machine
(`automation_runs`, `automation_run_steps`, `automation_waits`). The executor sits behind an
interface.

## Alternatives considered
- **Temporal.** Rejected for now: workflow-as-code does not fit user-authored workflows;
  operating a Temporal cluster is a large commitment at Phase 2 team size.
- **Chained queue jobs.** Rejected: no run history, no inspection, no resumable delays, no
  branching. Debugging "why did this customer get two emails?" becomes archaeology.
- **A third-party automation SaaS.** Rejected: automation is a core product surface, not an
  outsourceable component.

## Consequences
**Positive:** every run is fully inspectable and replayable; a worker can die at any point
and another resumes from the last committed step; in-flight runs keep their version.

**Negative:** we own durability semantics, and getting them wrong is expensive. Mitigated by
per-step idempotency, recursion guards, bounded loops, explicit timeouts and a chaos-drill
suite.

**Exit condition:** if durability requirements outgrow this design, Temporal can back the
executor behind the same interface without changing stored workflow data.
