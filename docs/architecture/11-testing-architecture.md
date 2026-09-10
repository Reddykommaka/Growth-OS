# 11 — Testing Architecture

## 1. Shape of the suite

Weighted by defect-catching value per second of CI time, not by dogma.

```
        ╱ E2E (Playwright) ~40 specs          critical workflows only
      ╱ Integration (Vitest + real Postgres)  the largest and most valuable layer
    ╱ Component (Testing Library + axe)
  ╱ Unit (Vitest)                             domain logic, pure functions
 ▔▔ Static (tsc, Biome, ESLint, dep-cruiser)  runs first, fails fastest
```

The integration layer is deliberately heavy. This system's real risks — tenant isolation,
authorization, transactional side effects, RLS, migrations — are *not* observable in unit
tests with mocked repositories. A mocked database cannot fail to isolate a tenant.

## 2. The database harness

Integration tests run against **real PostgreSQL**, never a mock or SQLite.

The environment has no Docker daemon but does have full PG 16 server binaries
([00](00-assessment.md) §2), so `packages/testing` provides:

1. **Cluster bootstrap** — `initdb` into a temp directory, `pg_ctl start` on an ephemeral
   port with `fsync=off` and `full_page_writes=off` (safe: the data is disposable, and it
   roughly halves suite time). Reused across a run, torn down after.
2. **Template database** — migrations run **once**, then each test file clones with
   `CREATE DATABASE … TEMPLATE …`. Clone is milliseconds; re-migrating per file is not.
3. **Per-test isolation** — each test runs in a transaction rolled back at the end. Tests
   that must commit (outbox relay, advisory locks) get a dedicated database from the
   template pool.
4. **RLS-realistic connections** — the harness connects as `growth_os_app`, the
   `NOBYPASSRLS` role, and sets tenant context exactly as production does. **Tests that
   bypass RLS would validate a system we do not ship.**
5. **Testcontainers is an optional path** where a Docker daemon exists — never the only path,
   or the suite becomes unrunnable in environments like this one.

Redis is faked in-process for unit and integration tests (the `jobs`, `cache` and
`ratelimit` ports each ship a fake); a real Redis runs in CI and staging.

## 3. Authorization testing — generated, not hand-written

The permission catalogue is an exhaustive TypeScript union ([06](06-identity-and-access.md) §3),
which makes the matrix enumerable. A generated suite asserts, for **every**
`(role × permission × scope)` combination, that access matches the declared policy.

Consequences that matter:
- Adding a permission without adding it to the matrix **fails the build**. There is no
  "we forgot to test that endpoint".
- Adding a permission to a role produces a reviewable diff of exactly what that role can now
  do — which is the artefact a security reviewer actually needs.

Additional required suites:
- **Three-scope resolution** — a role granted at organization, team and workspace scope
  produces exactly the expected accessible-workspace set, including through
  `team_workspace_access`, and including after a workspace is moved between teams.
- **`client_guest` containment** — the most security-sensitive role, because it is held by
  someone outside the tenant organization. Asserts the guest can approve and comment in
  their one workspace, and is denied every billing, member-management, cost, analytics-cost
  and integration-credential permission, and every other workspace in the organization.
- **Ownership rules** (e.g. `crm.deal:update` on a deal you own but not on another's).
- **Resource grants** grant and revoke correctly, and revocation takes effect immediately.
- **Escalation attempts**: a `member` cannot assign themselves `admin`; a `workspace_admin`
  in workspace A has nothing in workspace B; an expired invitation cannot be redeemed;
  a revoked API key fails on the next request.
- **Impersonation** is bounded, audited and denied on billing and credential paths.

## 4. Tenant isolation testing — the non-negotiable suite

Four structural tests, all of which fail the build rather than warn:

1. **Schema completeness** — enumerate `information_schema.columns`; every table with an
   `organization_id` must have RLS `ENABLED` *and* `FORCED` and at least one policy with
   both `USING` and `WITH CHECK`. A new table cannot silently opt out of isolation.
2. **Role posture** — assert `growth_os_app` has `rolbypassrls = false`, and that it holds
   no `UPDATE`/`DELETE` grant on `audit_events`.
3. **Cross-tenant probes** — for every tenant-scoped table: seed a row in Org B, open Org A
   context, and assert `SELECT` returns zero rows and that `UPDATE`, `DELETE` and an
   `INSERT` carrying B's `organization_id` all affect nothing. Generated from the schema, so
   coverage grows with the schema automatically.
4. **Missing-context probe** — with no `app.organization_id` set, every tenant-scoped table
   returns zero rows. Fails closed, verified.

The marketplace's deliberate cross-tenant reads get their own explicit suite: published
listings **are** readable across tenants; drafts, orders, payouts and seller financials are
**not**; an order is visible to exactly the buyer and seller organizations and no third.

## 5. Integration and contract testing

| Suite | Asserts |
| --- | --- |
| Application services | Real DB, real RLS, real transactions. Correct rows written, correct `outbox_events` and `audit_events` emitted **in the same transaction**, correct authorization failures |
| Repositories | Query correctness, index usage on hot paths (assert the plan, not just the result), pagination stability |
| Domain state machines | Every legal transition succeeds and **every illegal one is rejected** — generated from the machine definition, so new states get tests automatically |
| Provider adapters | One shared contract suite every adapter must pass, run against recorded HTTP fixtures: pagination, rate-limit handling, token refresh, and correct mapping of each provider error onto the normalized taxonomy ([07](07-integration-architecture.md) §4) |
| Live provider smoke | A separate, scheduled suite against sandbox accounts — **never in PR CI**, because a third party's availability must not gate a merge |
| Webhooks | Valid signatures accepted, invalid rejected, replays ignored, raw-body verification not broken by re-serialisation |
| Jobs | Idempotency (run twice → one effect), retry/backoff behaviour, DLQ routing, poison-message quarantine |
| Automation engine | Branching, delays, waits, loop bounds, recursion guard, resume-after-worker-death, in-flight runs keep their version |
| Money | Double-entry ledger balances to zero for every order/refund/commission/payout sequence; property-based tests over random sequences |
| Migrations | Every migration applies forward against a production-shaped schema; the lint rules in [05](05-data-architecture.md) §11 are enforced; a rollback-by-new-migration path is exercised |
| Analytics | Rollups computed incrementally equal a full rebuild from facts (property test); duplicate events do not double-count; attribution credit fractions sum to 1.0 per conversion per model; every result carries model, version, lookback and evidence |
| Intelligence | Retrieval is filtered by workspace **before** ranking (a cross-tenant probe seeds Org B content and asserts it can never surface for Org A); budget guards refuse invocation past a hard stop; structured outputs failing schema never reach the domain; provenance is written for every invocation with no unlogged path; capability golden-set evals run in CI and report a diff on prompt or model change |
| Marketplace money | Randomised order/refund/commission/payout sequences net to zero in the ledger (property test); prices and commission rates are snapshotted, so changing a listing price never restates an existing order |

## 6. Component, E2E and accessibility

**Component tests** (Testing Library) assert behaviour and accessibility, never
implementation detail. Every interactive component ships with an `axe` assertion and a
keyboard-navigation test; a component with no keyboard path does not merit review.

**E2E workflows** — deliberately few, each covering a path whose failure would be a
company-level incident:

1. Sign up → verify email → create organization → create workspace → invite → accept.
2. Connect a social account (mocked provider) → compose → request approval → approve →
   schedule → publish → verify metrics ingestion.
3. Build a landing page → publish → submit form → lead appears in CRM → deal created →
   deal won → **revenue attributed to the originating social post** (the full chain, end to
   end — this is the product's central promise and it gets a test).
4. Create an automation → trigger by event → branch → delay → action → inspect the run.
5. Marketplace: publish listing → buyer purchases → payment → seller payout → ledger
   balances → review submitted.
6. Subscribe to a plan → hit a quota → entitlement blocks the action → upgrade → unblocked.
7. Cross-tenant negative path: user of Org A cannot reach Org B's resources by direct URL.

Providers are stubbed at the HTTP layer in E2E so the suite is deterministic.

## 7. Performance and resilience testing

- **Query budgets** — integration tests assert a maximum query count per endpoint (N+1
  regressions fail CI rather than being discovered in production).
- **Load tests** (k6) against staging for the publishing scheduler, link redirect (p99 <
  50ms) and dashboard reads, with realistic multi-tenant data volumes.
- **Seeded scale fixtures** — a generated tenant with 2 years of facts, so report queries
  are exercised against realistic partition counts rather than empty tables.
- **Chaos drills** in staging: kill a worker mid-automation, take Redis down, expire a
  provider token, saturate a rate limit. Each has an expected, documented behaviour from the
  failure tables in [07](07-integration-architecture.md) and [08](08-automation-architecture.md),
  and the drill verifies it.

## 8. Standards and gates

| Gate | Threshold |
| --- | --- |
| Type check, lint, format, boundary rules | Zero errors |
| `domain/` + `application/` coverage | ≥ 90% lines, ≥ 85% branches |
| Overall coverage | ≥ 80%, and **not allowed to fall** relative to the base branch |
| Authorization & tenant-isolation suites | 100% pass; no skips permitted |
| Flaky tests | Quarantined with an owner and a deadline; a permanently skipped test is deleted |
| Every bug fix | Ships with a regression test that fails without the fix |
| Test data | Factories with explicit overrides; no shared mutable fixtures; deterministic seeds; time is injected via a `Clock` port, never `Date.now()` in domain code |
