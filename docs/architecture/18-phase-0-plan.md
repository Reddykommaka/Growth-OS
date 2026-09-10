# 18 — Phase 0: Exact Implementation Plan

**Goal:** a repository where correct code is the path of least resistance and incorrect code
fails the build — *before* any business logic exists to be written incorrectly.

**Duration:** ~2.5 weeks. **Output:** no product features. A trivial endpoint deployable to
staging through the full pipeline, with every architectural guarantee already enforced by CI.

Phase 0 exists because every rule in this architecture that is stated as "always" or "never"
needs a mechanism. Building the mechanisms first means the rules are free thereafter;
building them later means retrofitting them against code that already violates them.

---

## Work item 0.1 — Workspace skeleton *(1 day)*

Create the pnpm workspace, Turborepo pipeline and package graph exactly as specified in
[03-repository-structure.md](03-repository-structure.md).

- `pnpm-workspace.yaml`, root `package.json` (private, `packageManager` pinned), `turbo.json`
  with `build`/`lint`/`typecheck`/`test`/`test:integration`/`e2e` tasks and correct
  `dependsOn` and `outputs`.
- `apps/{web,api,worker,link}` and every `packages/*` directory from the layout, each with a
  `package.json` whose `exports` map exposes only its public entry points.
- Shared `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `isolatedModules`, project references.
- `.nvmrc` / `engines` pinned to Node 22.

**Done when:** `pnpm install && pnpm turbo typecheck` succeeds across an empty graph, and a
deliberate deep import (`@growth-os/social/domain/...`) fails to resolve.

## Work item 0.2 — Boundary enforcement *(1 day)*

The four mechanisms from [03](03-repository-structure.md) §2, with a failing test for each.

- `dependency-cruiser` config encoding: the layer rule (`domain ← application ←
  infrastructure`), "apps may import only `contracts`", "`packages/ui` may not import
  `packages/modules`", and no-cycles.
- ESLint `no-restricted-imports`: `drizzle-orm`, `ioredis`, `bullmq` and provider SDKs banned
  from `domain/` and `application/`; **`@anthropic-ai/sdk` and `openai` banned everywhere
  except `packages/integrations/*`** ([ADR-0013](../adr/0013-model-provider-abstraction.md)).
- Explicit-`any` and non-null-assertion bans outside test files; file-length and
  function-length caps.
- Biome for format and fast lint.
- **A `boundaries.test.ts` fixture set** containing deliberately illegal imports, asserting
  each is rejected. The enforcement itself is tested — otherwise a misconfigured rule silently
  enforces nothing.

**Done when:** each of the four mechanisms rejects a known-bad fixture, proven by test.

## Work item 0.3 — Platform primitives *(2 days)*

`packages/platform/{config,types,errors,logger,telemetry}`.

- **`config`** — Zod env schema split `server` / `client` (`NEXT_PUBLIC_` required for the
  latter), parsed at boot with fail-fast, plus a build-time check that no server key is
  referenced from a client bundle. `.env.example` with names only.
- **`types`** — branded ids (`OrganizationId`, `TeamId`, `WorkspaceId`, `UserId`, …), the
  **`Money` type** (integer minor units + ISO-4217, no float constructor), `Result`,
  pagination primitives, and the `Clock` port so no domain code calls `Date.now()`.
- **`errors`** — the taxonomy (`NotFoundError`, `ForbiddenError`, `ValidationError`,
  `ConflictError`, `RateLimitedError`, `BudgetExceededError`, …) and RFC 9457 problem+json
  serialisation that never leaks internals.
- **`logger`** — pino with the redaction list applied **at the serializer** (`token`,
  `secret`, `authorization`, `refresh_token`, `password`, `api_key`), and correlation context
  (`request_id`, `organization_id`, `workspace_id`, `actor_id`, `job_id`).
- **`telemetry`** — OpenTelemetry bootstrap, span helpers, resource attributes.

**Done when:** a test asserts a secret-valued field cannot appear in log output through any
code path, and that `Money` cannot be constructed from a float.

## Work item 0.4 — Database harness *(2 days)*

The single highest-leverage item in Phase 0: it makes every subsequent phase's integration
tests possible.

- `packages/testing/pg`: `initdb` into a temp dir, `pg_ctl` on an ephemeral port with
  `fsync=off`, `full_page_writes=off`; teardown on exit; **no Docker requirement**
  ([00](00-assessment.md) §2).
- Template-database strategy: migrate once, then `CREATE DATABASE … TEMPLATE …` per test file.
- Per-test transaction rollback, plus a committed-database pool for tests that need real
  commits (outbox relay, advisory locks).
- **Connections use `growth_os_app` (`NOBYPASSRLS`)** and set tenant context exactly as
  production does. Tests that bypass RLS would validate a system we do not ship.
- Roles created in migration 0001: `growth_os_app` (`NOBYPASSRLS`, per-table grants, **no
  `UPDATE`/`DELETE` on `audit_events`**) and `growth_os_migrator` (`BYPASSRLS`).
- In-process fakes for the `jobs`, `cache` and `ratelimit` ports (no Redis server here).

**Done when:** a test opens a real cluster, applies migrations, writes and rolls back, in
under 5 seconds cold.

## Work item 0.5 — Migration tooling and lint *(1.5 days)*

- Migration runner: forward-only, numbered, immutable-once-merged, applied by
  `growth_os_migrator` in a discrete job with `lock_timeout` and `statement_timeout` set.
  **Never on application boot.**
- `db/policies/` convention for RLS policies as separately-reviewed artefacts.
- **Migration lint** rejecting: `timestamp without time zone`; float/numeric money columns;
  native `enum` types; a foreign key without a covering index; a tenant-scoped table without
  RLS `ENABLED` *and* `FORCED` and a policy with both `USING` and `WITH CHECK`; blocking
  `ALTER` patterns; index creation without `CONCURRENTLY` outside the initial migration.
- **Structural test suite** (the four from [11](11-testing-architecture.md) §4): schema
  completeness, role posture, cross-tenant probes, missing-context fail-closed. Generated
  from `information_schema`, so coverage grows with the schema automatically.
- Migration 0001: extensions (`pgcrypto`, `citext`, `pg_trgm`, `vector`), roles, and the
  partition-management helper functions.

**Done when:** a deliberately bad migration (float money, missing RLS, unindexed FK) fails CI
for the right reason, proven by fixture.

## Work item 0.6 — Design system foundation *(2.5 days)*

Per [13-design-system.md](13-design-system.md).

- Three-tier tokens as CSS custom properties; light and dark themes; the Tailwind v4 preset
  restricting utilities to token values (arbitrary values lint-blocked).
- Typography scale, tabular numerals, the 4px grid, small-radius and border-first elevation
  rules encoded as tokens.
- First primitives on Radix: Button, Input, Select, Checkbox, Dialog, Popover, Tooltip, Menu,
  Tabs.
- Storybook with a state matrix per component (default/hover/focus/disabled/loading/error/
  empty) in both themes.
- `axe` assertion and keyboard-navigation test **required by the component test helper**, so a
  component without them cannot pass review.

**Done when:** every primitive passes `axe` in both themes and is fully keyboard operable.

## Work item 0.7 — CI pipeline *(2 days)*

Per [12-devops-architecture.md](12-devops-architecture.md) §3, in fail-fastest order:

```
install (frozen lockfile, cached)
  → static:   tsc · biome · eslint · dependency-cruiser
  → security: gitleaks · pnpm audit · OSV · CodeQL · licence check
  → unit + component (sharded)
  → integration (real Postgres via the harness; migrations; RLS; structural suites)
  → migration checks (forward apply + lint rules)
  → build (turbo remote cache)
  → e2e (Playwright, browsers pre-provisioned at /opt/pw-browsers)
  → preview deploy + smoke
```

- Coverage gates configured but thresholds set to current (they ratchet up, never down).
- Branch protection: `main` requires every gate.
- `gitleaks` also as a **pre-commit hook** — the repository is public, so the first line of
  defence must be local ([10](10-security-architecture.md) §3).

**Done when:** a PR containing a secret, a boundary violation, a bad migration or an
inaccessible component is rejected by CI — each proven by a deliberately failing PR.

## Work item 0.8 — Runtime, infrastructure and health *(2 days)*

- Multi-stage Dockerfile producing all four app images; non-root user; SBOM generation;
  image signing.
- `/healthz` (liveness, no dependencies) and `/readyz` (readiness: database, Redis,
  **migration version** — a replica on old code against a new schema must not serve traffic).
- Terraform skeleton: `infra/terraform/{modules,envs/staging}` — container platform, managed
  Postgres, managed Redis, object storage with a **separate user-content origin**, secret
  manager, remote state with locking.
- Staging deploy from `main` with the migration job as a discrete pre-deploy step.
- OpenTelemetry export wired end to end; Sentry with release tracking and source maps.

**Done when:** a trivial `/v1/ping` route in `apps/api` is reachable on staging, appears as a
trace, and its errors reach Sentry.

## Work item 0.9 — Documentation and process *(1 day)*

- `SECURITY.md` (disclosure policy and address), `CONTRIBUTING.md` (PR expectations, review
  requirements, the second-reviewer rule for `authn`/`authz`/`db/policies/`/marketplace money).
- ADR template and process; `docs/runbooks/` skeleton with the rule that a paging alert
  without a runbook is deleted or downgraded.
- `docs/integrations/` template for per-provider setup.
- PR template prompting: which module owns this, which permission gates it, which failure
  mode it introduces, and whether a threat-model note is required.

---

## Phase 0 exit criteria

Phase 0 is complete when **all** of the following are demonstrably true, each by a test or a
deliberately-failing PR rather than by assertion:

| # | Criterion |
| --- | --- |
| 1 | `pnpm install && pnpm turbo build test` passes from a clean clone |
| 2 | A deep import across a module boundary fails to build |
| 3 | An import of a provider SDK from product code fails lint |
| 4 | An explicit `any` fails the build |
| 5 | A migration with a float money column, a missing RLS policy, an unindexed FK or a non-`timestamptz` timestamp fails CI |
| 6 | The four structural tenant-isolation suites run and pass against a real cluster |
| 7 | Integration tests run against real Postgres **with no Docker daemon** |
| 8 | A committed secret is blocked at pre-commit **and** in CI |
| 9 | Every design-system primitive passes `axe` and keyboard tests in both themes |
| 10 | A trivial endpoint deploys to staging through the full pipeline, with traces and errors flowing |
| 11 | `/readyz` fails when the migration version does not match the code's expectation |
| 12 | The `Money` type cannot be constructed from a float; the logger cannot emit a redacted field |

## What Phase 0 deliberately does **not** include

No entities, no schema beyond roles and extensions, no authentication, no UI screens, no
provider adapters, no seed data that simulates functionality. Phase 0 builds the machine that
enforces the architecture — nothing that pretends to be the product.

## Immediately after approval to build

The first three work items (0.1 workspace skeleton, 0.2 boundary enforcement, 0.4 database
harness) are on the critical path for everything else and are done first. 0.6 (design system)
can proceed in parallel from day one if a second person is available, as it shares no
dependencies with the rest.
