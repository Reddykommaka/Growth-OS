# Architecture Decision Records

An ADR records a decision that was expensive to make and would be expensive to reverse:
the context, the choice, the alternatives, and the consequences we accepted.

**Rules**
- An accepted ADR is **immutable**. Reversing one means writing a new ADR that supersedes it.
- The consequences section must include the *negative* ones. An ADR that only lists benefits
  is marketing, not a record.
- A decision that contradicts an accepted ADR is a blocking review comment.

**Status values:** `Proposed` · `Accepted` · `Superseded by ADR-XXXX` · `Deprecated`

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-modular-monolith.md) | Modular monolith over microservices | Proposed |
| [0002](0002-postgres-and-drizzle.md) | PostgreSQL with Drizzle ORM and SQL migrations | Proposed |
| [0003](0003-tenancy-model.md) | Shared schema with RLS; organization + workspace | Proposed |
| [0004](0004-api-surfaces.md) | Server Actions for first-party, REST for public; no GraphQL | Proposed |
| [0005](0005-automation-engine.md) | Data-driven automation engine over Temporal | Proposed |
| [0006](0006-own-identity.md) | Own the identity tables; assemble auth from libraries | Proposed |
| [0007](0007-transactional-outbox.md) | Transactional outbox for domain events | Proposed |
| [0008](0008-analytics-storage.md) | Postgres-first analytics behind an AnalyticsQueryPort | Proposed |
| [0009](0009-sessions-over-jwt.md) | Opaque server sessions instead of JWTs | Proposed |
| [0010](0010-own-design-system.md) | Own design system on Radix primitives | Proposed |
| [0011](0011-marketplace-extensibility.md) | Listing types + typed attribute values | Proposed |
| [0012](0012-money-and-ledger.md) | Integer minor units and a double-entry ledger | Proposed |

All are `Proposed` pending approval of this architecture.
