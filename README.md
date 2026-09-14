# Growth OS

A multi-tenant operating system for business growth: **Social Growth OS**, **Marketplace**
and **Marketing OS** on one shared platform.

**Agency-first.** The primary customer is a marketing or social agency managing many
clients — Organization → Team → Workspace — with direct businesses supported natively.

## Status

**Architecture approved (2026-09-10). Phase 0 (foundation) implemented and green.
No product features exist yet — by design.**

The workspace was inspected and found to be a clean greenfield repository. Rather than
generating application files, this branch established the production architecture first —
tenancy, module boundaries, the data model, the attribution spine and AI governance are the
decisions that cannot be cheaply reversed once real data exists.

[Phase 0](docs/architecture/18-phase-0-plan.md) then built the machine that enforces that
architecture: the package graph, four independent boundary mechanisms, real-PostgreSQL
integration harness, migration lint, design-system foundation, CI and a staging pipeline.
Phase 1 (tenancy and access) is the next increment and has not begun.

```
pnpm install && pnpm typecheck && pnpm lint && pnpm test   # no services required
pnpm test:integration                                      # needs PostgreSQL 16 binaries + pgvector
```

Integration tests bootstrap a throwaway cluster from the PostgreSQL binaries — no Docker
daemon and no running server. See
[the database prerequisites runbook](docs/runbooks/database-prerequisites.md).

## Start here

→ **[19 — Approved architecture summary](docs/architecture/19-approved-summary.md)** —
consolidated domain map, dependency graph, implementation sequence, remaining decisions and
new risks.

→ **[docs/README.md](docs/README.md)** — the full set: 20 architecture documents and
[16 Architecture Decision Records](docs/adr/README.md).

If you read only four:

1. [Approved summary](docs/architecture/19-approved-summary.md) — the whole thing in one page.
2. [Data architecture](docs/architecture/05-data-architecture.md) — entities, tenancy,
   indexes, lifecycle, retention, migration strategy.
3. [AI & intelligence architecture](docs/architecture/16-intelligence-architecture.md) —
   how AI is a governed platform capability rather than scattered calls.
4. [Phase 0 plan](docs/architecture/18-phase-0-plan.md) — exactly what gets built first.
