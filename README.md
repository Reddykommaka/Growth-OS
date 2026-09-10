# Growth OS

A multi-tenant operating system for business growth: **Social Growth OS**, **Marketplace**
and **Marketing OS** on one shared platform.

## Status

**Architecture proposal — awaiting approval. No application code exists yet.**

The workspace was inspected and found to be a clean greenfield repository. Rather than
generating application files, this branch establishes the production architecture first —
tenancy, module boundaries, the data model and the event/attribution spine are the decisions
that cannot be cheaply reversed once real data exists.

## Start here

→ **[docs/README.md](docs/README.md)** — the full architecture document set (16 documents)
and [12 Architecture Decision Records](docs/adr/README.md).

If you read only three:

1. [Architecture overview](docs/architecture/01-overview.md) — the system's shape and the
   principles that are mechanically enforced.
2. [Data architecture](docs/architecture/05-data-architecture.md) — entities, tenancy,
   indexes, lifecycle, retention, migration strategy.
3. [Risks & open questions](docs/architecture/15-risks.md) — including the questions that
   need answers before implementation starts.
