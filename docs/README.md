# Growth OS — Documentation

Growth OS is a multi-tenant operating system for business growth, composed of three
products on one shared platform:

| Product | Purpose |
| --- | --- |
| **Social Growth OS** | Plan, produce, publish, moderate and measure social presence. |
| **Marketplace** | Discover, buy, sell and hire the resources needed to grow. |
| **Marketing OS** | Run the full customer-acquisition lifecycle across every channel. |

## Architecture documents

| # | Document | Covers |
| --- | --- | --- |
| 00 | [Current project assessment](architecture/00-assessment.md) | Workspace inspection, constraints, greenfield findings |
| 01 | [Architecture overview](architecture/01-overview.md) | System shape, runtime topology, core principles |
| 02 | [Technology stack](architecture/02-technology-stack.md) | Every dependency choice with rationale |
| 03 | [Repository structure](architecture/03-repository-structure.md) | Monorepo layout, boundary enforcement |
| 04 | [Domain & module architecture](architecture/04-domain-architecture.md) | Module map, layering, inter-module contracts |
| 05 | [Data architecture](architecture/05-data-architecture.md) | Entities, tenancy, keys, indexes, lifecycle, retention |
| 06 | [Identity, authentication & authorization](architecture/06-identity-and-access.md) | Sessions, RBAC, RLS, tenant isolation |
| 07 | [Integration architecture](architecture/07-integration-architecture.md) | Provider ports, credentials, webhooks, rate limits |
| 08 | [Automation architecture](architecture/08-automation-architecture.md) | Workflow engine, queues, outbox, idempotency |
| 09 | [Analytics & attribution architecture](architecture/09-analytics-architecture.md) | Touchpoints, identity graph, attribution, ROI |
| 10 | [Security architecture](architecture/10-security-architecture.md) | Threat model, controls, secrets, encryption |
| 11 | [Testing architecture](architecture/11-testing-architecture.md) | Test pyramid, tenancy tests, contract tests |
| 12 | [Deployment & DevOps architecture](architecture/12-devops-architecture.md) | Environments, CI/CD, migrations, observability |
| 13 | [Design system](architecture/13-design-system.md) | Tokens, primitives, density, accessibility |
| 14 | [Development phases](architecture/14-roadmap.md) | Sequenced delivery plan |
| 15 | [Risks & open questions](architecture/15-risks.md) | Ranked risks with mitigations |
| 16 | [AI & intelligence architecture](architecture/16-intelligence-architecture.md) | Provider abstraction, grounding, capabilities, recommendations, governance |
| 17 | [Marketplace architecture](architecture/17-marketplace-architecture.md) | Participants, catalogue, orders, money, trust, ecosystem links |
| 18 | [Phase 0 implementation plan](architecture/18-phase-0-plan.md) | Exact work items and exit criteria |
| 19 | [**Approved architecture summary**](architecture/19-approved-summary.md) | Consolidated view: domain map, dependency graph, sequence, remaining decisions, new risks |
| 20 | [Phase 0 implementation gate](architecture/20-phase-0-gate.md) | Evidence for each Phase 0 exit criterion, and what is explicitly not yet proven |

**Start here:** [19 — Approved architecture summary](architecture/19-approved-summary.md).

## Architecture Decision Records

See [`docs/adr/`](adr/README.md) — 16 accepted ADRs, and [TEMPLATE.md](adr/TEMPLATE.md) for
writing one. ADRs are immutable once accepted; a reversal is a new ADR that supersedes the
old one.

## Operations and process

| Document | Covers |
| --- | --- |
| [Runbooks](runbooks/README.md) | One per paging alert. An alert without a runbook is deleted or downgraded |
| [Database prerequisites](runbooks/database-prerequisites.md) | PostgreSQL version, extensions and roles every environment must provide |
| [Integration template](integrations/TEMPLATE.md) | Per-provider setup, capabilities, rate limits, error mapping, gotchas |
| [Lint rationale](lint-rationale.md) | Why each non-obvious lint rule is configured the way it is |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Setup, the rules CI enforces, review requirements |
| [SECURITY.md](../SECURITY.md) | Vulnerability reporting, scope, safe harbour |

## Status

**Architecture approved (2026-09-10). Awaiting approval to begin structural implementation.**

No application code exists yet. Nothing in this directory has been implemented.

### Approved strategic decisions applied

| # | Decision | Where it landed |
| --- | --- | --- |
| 1 | Commercial order: Social → Marketing → Marketplace; all three first-class | [01](architecture/01-overview.md) §2, [14](architecture/14-roadmap.md) |
| 2 | Agency-first: Organization → Team → Workspace; direct business native | [04](architecture/04-domain-architecture.md), [05](architecture/05-data-architecture.md), [06](architecture/06-identity-and-access.md), [ADR-0003](adr/0003-tenancy-model.md) |
| 3 | Tier 1: Instagram, Facebook, YouTube, LinkedIn, TikTok · Tier 2: X, Pinterest, Threads | [07](architecture/07-integration-architecture.md) §1, [ADR-0015](adr/0015-meta-provider-family.md) |
| 4 | AI as a platform capability, multi-provider | [16](architecture/16-intelligence-architecture.md), [ADR-0013](adr/0013-model-provider-abstraction.md), [ADR-0016](adr/0016-ai-governance.md) |
| 5 | Cloud-portable, managed infrastructure, no unnecessary distribution | [12](architecture/12-devops-architecture.md) §2, §9 |
| 6 | Attribution spine foundational, with model/version/lookback and source evidence | [09](architecture/09-analytics-architecture.md) §5 |
| 7 | Marketplace first-class, double-entry ledger retained | [17](architecture/17-marketplace-architecture.md), [ADR-0012](adr/0012-money-and-ledger.md) |
| 8 | Cross-product intelligence layer | [16](architecture/16-intelligence-architecture.md), [ADR-0014](adr/0014-intelligence-layer.md) |
