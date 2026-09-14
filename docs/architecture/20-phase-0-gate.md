# 20 — Phase 0 Implementation Gate

**Status:** PASSED (with two criteria partially satisfied — recorded below, not waived).
**Gate run commit:** `049e63c` — *docs(phase-0): security policy, contributing guide, templates and runbooks [0.9]*
**Date:** 2026-09-14
**Authority:** [18-phase-0-plan.md](18-phase-0-plan.md) § *Phase 0 exit criteria*

This document records the evidence for each of the twelve exit criteria. It exists because
"Phase 0 is done" asserted in a commit message is not a control. Each row below names the
command that produces the evidence and the test that would fail if the guarantee regressed.

---

## 1. Gate run — all stages

Executed at `049e63c` with a clean working tree, on the branch
`claude/growth-os-production-arch-rnbqyv`.

| Stage | Command | Result |
| --- | --- | --- |
| Static | `pnpm run lint` | exit 0 — 7/7 gates |
| Types | `pnpm run typecheck` | exit 0 |
| Build | `pnpm run build` | exit 0 — 38/38 tasks |
| Unit + component | `pnpm run test` | exit 0 — 20/20 tasks |
| Integration | `pnpm run test:integration` | exit 0 — 12/12 tasks, real PostgreSQL |
| Browser | `pnpm run e2e` | exit 0 — 10/10 Playwright tests |

The seven static gates are `biome format`, `biome lint`, `dependency-cruiser`
(143 modules / 115 dependencies cruised), file-size cap, client-env leak scan, migration
lint (2 migrations), and schema-version drift check.

**`dependency-cruiser` module count is load-bearing.** During 0.2 the tool silently cruised
zero modules while reporting success (a TypeScript 7 incompatibility). The count is
asserted by `boundaries.test.ts:91` — *"actually parses the fixtures (guards against a
config that cruises nothing)"* — so a green tick that enforces nothing fails the build.

---

## 2. Exit criteria

| # | Criterion | Evidence | Status |
| --- | --- | --- | --- |
| 1 | `pnpm install && pnpm turbo build test` passes from a clean clone | Gate run above; CI `install → static → test` job | **PASS** |
| 2 | A deep import across a module boundary fails to build | `boundaries.test.ts:50` *exports maps expose only a package public surface*; `:81` dependency-cruiser fixture set | **PASS** |
| 3 | An import of a provider SDK from product code fails lint | `boundaries.test.ts:127` *biome rejects banned imports*; `biome.json` path-scoped `noRestrictedImports` ([ADR-0013](../adr/0013-model-provider-abstraction.md)) | **PASS** |
| 4 | An explicit `any` fails the build | `boundaries.test.ts:185` *typescript strictness rejects unsafe code*; `:202` implicit any; `:208` unchecked indexed access | **PASS** |
| 5 | A bad migration (float money, missing RLS, unindexed FK, non-`timestamptz`) fails CI | `migrations.test.ts:33` *migration lint rejects violations* — `:52` missing RLS, `:58` missing `WITH CHECK`, `:62` uncovered FK, `:66` each failure carries its architectural reason; `:74` positive controls stay silent | **PASS** |
| 6 | The four structural tenant-isolation suites run and pass against a real cluster | `structural.test.ts` — check 1 `:130`, check 2 `:172`, check 3 `:212`, check 4 `:274`; `:263` asserts coverage is catalogue-driven, not a hand-written list | **PASS** |
| 7 | Integration tests run against real Postgres **with no Docker daemon** | `harness.test.ts:25` *runs against a real PostgreSQL server* — `initdb`/`pg_ctl` on an ephemeral port; no container runtime present in this environment | **PASS** |
| 8 | A committed secret is blocked at pre-commit **and** in CI | `gates.test.ts:32` *a committed secret is blocked* — `:94` hook executable and wired, `:107` hook reads its allowlist from `.gitleaks.toml` (one source of truth), `:116` this suite holds no literal credential shape | **PASS** |
| 9 | Every design-system primitive passes `axe` and keyboard tests in both themes | `pnpm run e2e` 10/10 across light and dark; `gates.test.ts:132` proves the a11y gate itself rejects an unlabelled control, an unnamed icon button and a keyboard-unreachable component | **PASS** |
| 10 | A trivial endpoint deploys to staging through the full pipeline, with traces and errors flowing | Pipeline defined and unit-proven; **staging half not executed — see §3** | **PARTIAL** |
| 11 | `/readyz` fails when the migration version does not match the code's expectation | `health.test.ts:14` *schema version check*, `:42` fails when no migrations applied; `server.integration.test.ts:70` `/readyz`, `:120` *recovers once the migration is applied* | **PASS** |
| 12 | `Money` cannot be constructed from a float; the logger cannot emit a redacted field | `money.test.ts:16` *Money cannot be constructed from a float* (+ NaN/Infinity, unsafe integer, no float error under addition); `logger.test.ts:39` *redaction removes secrets before serialisation* — including inside a message, an `Error` stack, and under an innocuous key | **PASS** |

Ten of twelve criteria pass outright. Criterion 10 is partially satisfied and criterion 1's
"clean clone" leg is proven locally but not yet on a GitHub-hosted runner — both carried
forward explicitly below rather than marked done.

---

## 3. What is NOT proven — carried into Phase 1

These are stated plainly because a gate that launders unknowns into a pass is worse than no
gate.

**3.1 Nothing has been deployed.** No Docker daemon is available in this environment, so
the multi-stage image defined in `infra/docker/Dockerfile` has never been built. No cloud
credentials are present, so `infra/terraform/envs/staging` has never been applied. The
staging half of criterion 10 — *"reachable on staging, appears as a trace, errors reach
Sentry"* — is therefore **outstanding**. What *is* proven: the route exists, `/healthz` and
`/readyz` behave correctly under integration test, OpenTelemetry initialises and shuts down
cleanly, and the Sentry bootstrap is called on the real startup path.

**3.2 CI has never run on GitHub Actions.** `.github/workflows/ci.yml` is unproven on a
hosted runner. Specifically unverified: the pinned action versions resolve, the
`postgresql-16-pgvector` apt package installs on `ubuntu-latest`, and the gitleaks action
behaves as configured. The first push that opens a pull request is the first real test of
this file.

**3.3 No Terraform provider is pinned** — open question #7 in [15-risks.md](15-risks.md).
The skeleton is structurally correct but not reproducible until versions are constrained.

**3.4 Open question #1 remains unanswered** — jurisdictions and compliance posture at
launch (GDPR stance, EU data residency, SOC 2 timing). Phase 1 proceeds on the documented
working assumption: **GDPR-ready from Phase 1 with `data_region` present on the
organization but unused, SOC 2 evidence gathered continuously with the audit after GA.**
This assumption is cheap to hold and expensive to retrofit, which is why it is being made
rather than deferred. It is recorded here so that answering it later is a decision, not a
discovery.

---

## 4. Three failures worth remembering

Phase 0's dominant lesson is that **an enforcement mechanism must itself be tested**, because
all three of these were green and inert:

1. `dependency-cruiser` cruised **0 modules** while printing *"no dependency violations
   found"* — a TypeScript 7 peer incompatibility, failing open and silently.
2. An invalid rule (`pathNot: ['$1']`, an unsupported backreference) silenced **the entire
   ruleset**, not just itself.
3. The DROP-detection migration rule was **unsatisfiable** — it searched for its own
   exemption comment in text from which comments had already been stripped.

Each was caught only because a fixture asserted the rule *fires*. A suite that only asserts
clean code passes would have shipped all three.

A fourth, found by running the binary rather than a test: the OpenTelemetry `NodeSDK`
installs default OTLP exporters at `localhost:4318` and a failed flush on `SIGTERM` became
an unhandled rejection — every rolling deploy would have recorded a non-zero exit.

---

## 5. Gate decision

Phase 0's purpose was to make the architecture's "always" and "never" statements mechanical
before any business logic exists to violate them. That is achieved: 39 packages, ~330 tests,
seven static gates, three test tiers plus a browser suite, and tenant-isolation checks that
are generated from `information_schema` so **coverage grows with the schema automatically**
rather than depending on anyone remembering to add a test.

**Phase 0 is marked PASSED.** Phase 1 (Tenancy & Access) begins at commit `049e63c`, subject
to the four carried items in §3, which are tracked and not waived.
