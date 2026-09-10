# Runbooks

One runbook per paging alert. The rule from
[12-devops-architecture.md](../architecture/12-devops-architecture.md) §5 is strict, and it
is what keeps this directory useful:

> Every paging alert has a runbook, and an alert without one is deleted or downgraded.

An alert that wakes someone at 3am without telling them what to do is not monitoring — it is
noise with a pager attached.

## Writing one

Answer, in this order, for someone who did not build the system and is half awake:

1. **What fired, and what does it mean?** In plain language.
2. **Is the customer affected right now?** The first thing anyone needs to know.
3. **How do I confirm?** The exact query, dashboard or command.
4. **How do I mitigate?** The fastest safe action, before root-causing.
5. **How do I diagnose?** Where to look, in what order.
6. **What if that does not work?** Who to escalate to.
7. **Afterwards.** What to record, and whether this needs a post-mortem.

Prefer a command someone can paste over a paragraph describing one.

## Current runbooks

| Runbook | Covers |
| --- | --- |
| [database-prerequisites.md](database-prerequisites.md) | PostgreSQL version, extensions and roles every environment must provide |

## Planned, by phase

These are listed so the gap is visible rather than forgotten. Each lands with the subsystem
it covers, not after it:

| Runbook | Lands with |
| --- | --- |
| Outbox relay lag | Phase 2 — event spine |
| Queue backlog and dead-letter replay | Phase 2 — jobs |
| Provider connection degraded / token refresh failing | Phase 2 — integrations |
| Publish punctuality SLO breach | Phase 3 — publishing |
| Ledger balance assertion non-zero | Phase 2 — money primitives |
| AI spend anomaly / budget exhausted | Phase 2 — AI platform |
| Cross-tenant authorization-denial spike | Phase 1 — authz |
| Database failover and PITR restore drill | Phase 0 hardening |
| Rollback a bad deploy | Phase 0 hardening |
