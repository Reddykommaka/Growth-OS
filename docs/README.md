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

## Architecture Decision Records

See [`docs/adr/`](adr/README.md). ADRs are immutable once accepted; a reversal is a new
ADR that supersedes the old one.

## Status

**Proposal — awaiting approval.** No application code exists yet. Nothing in this
directory has been implemented. See [14-roadmap.md](architecture/14-roadmap.md) for the
sequence that follows approval.
