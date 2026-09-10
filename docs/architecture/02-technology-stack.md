# 02 — Recommended Technology Stack

Every entry states *why*, and what it was chosen *over*. Versions are those verified as
current on 2026-09-10 ([00](00-assessment.md) §3). All are pinned exactly; upgrades are
deliberate PRs, not `^` drift.

## 1. Language and runtime

| Choice | Version | Rationale | Considered instead |
| --- | --- | --- | --- |
| **TypeScript** | 7.0.2, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | One language across UI, API, workers and migrations means domain types, Zod schemas and permission literals are shared, not re-declared. The 7.x native compiler makes whole-monorepo typecheck fast enough to run on every commit. | Go or Java for the backend — rejected: it doubles the type definitions and halves the shared-validation benefit, for a performance profile this workload does not need. |
| **Node.js** | 22 LTS (matches the environment) | Broadest provider-SDK coverage; stable LTS through the first product year. | Bun — too young for a payments/PII path; Deno — SDK-compatibility friction. |

**TypeScript 7 risk:** the compiler line is new. Mitigation: CI runs typecheck on both
`typescript@7` and the `6.x` line for the first two months; if 7 proves unstable we pin to
6 with a one-line change, since we use no 7-only syntax. Tracked in [15-risks.md](15-risks.md).

## 2. Frontend

| Choice | Version | Rationale |
| --- | --- | --- |
| **Next.js (App Router), Node runtime** | 16.3.4 | Server Components let dense enterprise tables render server-side with the data already authorized, which removes an entire class of "the client asked for data it shouldn't see" bugs. Node runtime (not Edge) so we hold pooled Postgres connections. |
| **React** | 19.3.0 | Baseline for Next 16; Server Actions are the BFF write path. |
| **Tailwind CSS** | 4.3.3 | v4 is CSS-variable-native, which is exactly how our design tokens are expressed — themes switch by swapping variables, not by shipping two stylesheets. Utility classes are constrained to token values only; arbitrary values are lint-blocked. |
| **Radix UI primitives** | current | Unstyled, accessible behaviour (focus traps, roving tabindex, ARIA) that we should never hand-roll. We supply 100% of the visual layer, which is how we avoid looking like a template ([13](13-design-system.md)). |
| **TanStack Query** | 5.102.8 | Client cache for the interactive/realtime surfaces (inbox, calendar drag-drop) where RSC round-trips are too coarse. |
| **TanStack Table (headless) + virtualizer** | current | Dense, virtualized enterprise grids. |
| **visx** (+ d3-scale) | current | Charts composed from primitives, themed by our tokens. Chosen over Recharts/Chart.js because those impose their own visual language, which is the "generic dashboard" failure mode we are told to avoid. |
| **next-intl** | current | i18n from day one, ICU message format ([05](05-data-architecture.md) §8). |

Explicitly **not** used: shadcn/ui as a scaffold. Its copy-in approach is right, but its
default styling is the most recognisable "AI-generated SaaS" look in existence. We adopt
the pattern (own your component source) and none of the visual defaults.

## 3. Backend

| Choice | Version | Rationale | Considered instead |
| --- | --- | --- | --- |
| **Fastify** | 5.12.3 | Public REST API and webhook receivers. Fast, schema-first (JSON Schema derived from our Zod definitions), first-class raw-body access — which webhook signature verification requires and many frameworks make awkward. | Express (unmaintained ecosystem, no schema story); Nest (heavy DI ceremony we do not need given our own module discipline). |
| **Zod** | 4.6.1 | One schema per boundary, reused for: runtime validation, TS types, OpenAPI generation, and form validation on the client. | io-ts/valibot — smaller ecosystems for OpenAPI generation. |
| **`zod-openapi` → OpenAPI 3.1** | current | The public API spec is *generated from the code that validates requests*, so it cannot drift. Spec is committed; a CI diff check fails on unreviewed API changes. |

**API surface decision:** the first-party dashboard talks to the server through **Next.js
Server Actions and route handlers** (typed end-to-end without a separate RPC layer);
partners and API keys use the **versioned REST API** in `apps/api`. Both are thin adapters
over the same application services. tRPC was considered and rejected — it would add a
third surface that duplicates what Server Actions already give us, while contributing
nothing to the public API we must ship regardless. [ADR-0004](../adr/0004-api-surfaces.md).

## 4. Data

| Choice | Version | Rationale |
| --- | --- | --- |
| **PostgreSQL** | 16+ | Row-Level Security (our tenant-isolation backstop), declarative partitioning (analytics facts), `jsonb` with GIN, full-text search, `pg_trgm`, window functions, `generated` columns, logical replication. No other single datastore covers this product's needs. |
| **Drizzle ORM** | 0.45.2 | SQL-first with full TS inference. Critically: it does not fight `SET LOCAL`, RLS, CTEs, window functions, partial/expression indexes or partitioned tables — all of which our tenancy and analytics designs depend on. Migrations are readable SQL we review, not opaque engine output. |
| **Migrations: `drizzle-kit generate` → hand-reviewed SQL, applied by a dedicated runner** | — | Every migration is checked-in SQL. Anything RLS-, partition- or index-concurrency-related is written by hand. |
| **pgvector** | current | Embeddings for retrieval, in the same database as the data being retrieved — so a tenant filter is a `WHERE` clause on an already-isolated table rather than a second system's access-control model to get right. A dedicated vector database is deferred with a named trigger ([12](12-devops-architecture.md) §9). |
| **Redis** | 7+ | Queues (BullMQ), token-bucket rate limits, distributed locks, short-TTL caches. Never the system of record. |
| **S3-compatible object storage** | — | Media library, exports, uploads. Presigned direct upload/download; bytes never proxy through our app servers. |

**Drizzle's pre-1.0 version is a real risk.** Mitigation: the ORM is confined behind
repository classes inside each module's `infrastructure/` layer; no Drizzle type appears in
a domain, contract or application signature. If Drizzle breaks or stalls, the blast radius
is repository internals, and the migrations — plain SQL — are unaffected. Prisma was the
alternative; rejected because its `latest` tag currently points at an 8.0 release candidate
(mid-major churn) and because RLS + `SET LOCAL` + partitioning remain awkward there.
[ADR-0002](../adr/0002-postgres-and-drizzle.md).

## 5. Background work

| Choice | Version | Rationale |
| --- | --- | --- |
| **BullMQ on Redis** | 6.3.4 | Delayed jobs, repeatable schedules, priorities, per-queue concurrency, rate limiting, dead-letter — all needed by the publishing scheduler and ingestion pipelines. |
| **Transactional outbox in Postgres** | own | Redis alone cannot give "the row was written **and** the event will be delivered". The outbox does, without two-phase commit. |
| **Automation engine: own, data-driven, Postgres-backed** | own | End users author workflows in a UI, so workflows are *data*, not code. Temporal's workflow-as-code model does not fit that, and running a Temporal cluster is a large operational commitment. The executor sits behind an interface so Temporal can back the hardest durability cases later. [ADR-0005](../adr/0005-automation-engine.md). |

## 6. Integrations

| Concern | Choice |
| --- | --- |
| Payments & marketplace payouts | **Stripe** 22.6.2 — Billing for subscriptions, **Connect** for seller onboarding/KYC, split payments and payouts. Building marketplace payouts and KYC in-house is not defensible. |
| OAuth 2.0 / OIDC client flows | **arctic** 3.7.0 — per-provider flow correctness (PKCE, state, nonce) without owning our user tables. |
| Crypto primitives | **oslo** 1.2.1 + **`@node-rs/argon2`** 2.2.0 (Argon2id password hashing) |
| Email (transactional) | Behind an `EmailPort`; initial adapter Resend or SES. Provider is replaceable by design. |
| AI / model providers | Behind `ModelProviderPort`; adapters for `@anthropic-ai/sdk` (0.124.0) and `openai` (7.13.0). **No model SDK is imported outside its adapter — lint-enforced.** Model selection is a declarative router policy, never a hard-coded constant ([ADR-0013](../adr/0013-model-provider-abstraction.md)). |
| Enterprise SSO (SAML/OIDC) + SCIM | Deferred to Phase 7 behind an `EnterpriseIdentityPort`; WorkOS as the likely adapter. |

## 7. Quality, tooling and observability

| Concern | Choice | Rationale |
| --- | --- | --- |
| Monorepo | **pnpm workspaces** 10.33 + **Turborepo** 2.10 | pnpm's strict, non-hoisted `node_modules` makes undeclared cross-package imports *fail*, which turns our module boundaries into a mechanical guarantee. Turbo gives content-hashed task caching. Nx rejected: heavier, more generators, more opinion than we need. |
| Lint & format | **Biome** 2.5.12 — the sole linter | Biome 2.5 covers everything we need: `noExplicitAny`, `noNonNullAssertion`, `noRestrictedImports` (with per-path overrides), complexity and function-length caps, React hooks and a11y rules. **ESLint and `typescript-eslint` were dropped during Phase 0** — see below. |
| Boundary enforcement | **dependency-cruiser** 18.2 + package `exports` maps + pnpm strict resolution | Architecture violations fail CI. |
| File-length cap | `tools/scripts/check-file-size.mjs` | Biome has no max-lines-per-file rule; the 400-line cap from [03](03-repository-structure.md) §5 is enforced by this script and asserted by the architecture test suite. |

### Two toolchain findings from Phase 0 implementation

**`typescript-eslint` does not support TypeScript 7.** Its published peer range is
`>=4.8.4 <6.1.0`. Adopting it would have meant either pinning the whole repository to an
older compiler or running a linter against an unsupported parser. Since every rule we
actually required exists natively in Biome — which ships its own parser and therefore has
no TypeScript version coupling at all — ESLint was dropped entirely. This removes a
standing upgrade constraint rather than merely working around one.

**`dependency-cruiser` also does not yet support TypeScript ≥7**, and its failure mode is
dangerous: without a compatible compiler API it silently falls back, cruises **zero
modules**, and reports "no dependency violations found". A boundary check that enforces
nothing while appearing green is worse than no check. Two mitigations, both in place:

1. `pnpm.packageExtensions` pins a **parser-only** `typescript@6.0.3` inside
   dependency-cruiser's own `node_modules`. The build compiler is unaffected and stays on
   7.x.
2. The architecture test suite asserts `summary.totalCruised` is above a floor, so a
   configuration that stops parsing fails the build loudly instead of passing silently.
| Unit / integration tests | **Vitest** 5.0.0 | Same transform pipeline as the app; fast watch mode. |
| E2E / a11y | **Playwright** 1.63.0 + `@axe-core/playwright` | Browsers pre-provisioned in this environment. |
| Errors | **Sentry** 10.74 | Release health, source maps, user-impact grouping. |
| Traces / metrics / logs | **OpenTelemetry** SDK 0.222 → vendor-neutral collector | Never instrument against a vendor SDK directly. |
| Structured logging | **pino** | JSON logs with `request_id`, `organization_id`, `actor_id`, `job_id` on every line. |
| IaC | **Terraform** | Environments are reproducible, reviewable and diffable. |
| CI/CD | **GitHub Actions** | The repository is already on GitHub; no additional vendor. |

## 8. Dependency policy

- Exact versions; no `^`/`~` in any `package.json`. Renovate opens grouped upgrade PRs
  weekly; CI gates them.
- A new runtime dependency requires justification in the PR description: what it does, why
  not the standard library, its maintenance signal, and its transitive weight.
- `pnpm audit` + OSV scanning + `pnpm licenses` run in CI. Copyleft licences are blocked
  in application packages.
- Lockfile is committed and CI installs with `--frozen-lockfile`.
