# 21 — Phase 1 (Tenancy & Access): status

**Latest commit:** `b04ca6c` · **Branch:** `claude/growth-os-production-arch-rnbqyv`
**Phase 0 gate:** PASSED — [20-phase-0-gate.md](20-phase-0-gate.md)

Phase 1 is defined in [14-roadmap.md](14-roadmap.md). This records what is built, what is
proven, and what is not yet started — so the next session starts from fact rather than from
a commit log.

---

## 1. Work items complete

| # | Item | Commit |
| --- | --- | --- |
| 1.1 | Tenancy schema, RLS on every tenant table, `db/policies/` as a verifiable artefact | `b1bdacd` |
| 1.2 | `platform/authz`: catalogue, role model, policy engine, generated matrix | `6a1fca6` |
| 1.3 | Tenant-scoped unit of work; the `SET LOCAL` guarantee made structural | `51f55c1` |
| 1.4 | Actor resolution, provisioning, dual onboarding, the agency E2E | `b04ca6c` |

**18 tables** across migrations 0003–0006: 6 global identity tables (no RLS — a user belongs
to many organizations, so there is no tenant column to write a predicate against) and
**12 tenant-scoped tables**, every one with RLS `ENABLE`d, `FORCE`d and an explicit
`WITH CHECK`, each documented in `db/policies/<table>.sql`.

**93 permissions** in the catalogue, **13 system roles**, every `(role × permission)` pair
decided by a generated matrix.

## 2. Phase 1 exit criteria

> "authorization matrix and cross-tenant probe suites at 100%; an agency E2E (two pods, four
> clients, a client guest) passes; a reviewer can verify isolation from `db/policies/` alone."

| Criterion | Status | Evidence |
| --- | --- | --- |
| Authorization matrix at 100% | **MET** | `matrix.test.ts` — every role × every permission, generated from the catalogue; adding a permission without deciding each role's access fails the build |
| Cross-tenant probe suites at 100% | **MET** | `tenancy.test.ts` — all four structural checks over the real schema, catalogue-driven; plus hand-written probes for the two asymmetric policies the generic probe provably cannot cover |
| Agency E2E passes | **MET** | `agency-access.test.ts` + `agency-guest.test.ts` — two pods, four clients (five after onboarding one mid-test), a client guest, against a real cluster |
| Isolation verifiable from `db/policies/` alone | **MET** | 12 policy files, each stating who may read and who may write in plain language; `policies.test.ts` fails on drift in either direction — a stale file, or a tenant table with no file |

## 3. Not yet started

Phase 1 is **not complete**. These items from [14-roadmap.md](14-roadmap.md) remain:

- **`identity` authentication** — Argon2id password hashing, session issue and validation,
  email verification, TOTP/WebAuthn MFA, OAuth login via `arctic`, device management. The
  *schema* for all of it exists (migration 0003); none of the behaviour does.
- **Invitations and API keys** — tables exist; issue, redeem, revoke and authenticate do not.
- **Custom roles** — the schema and the resolver path support them; no management surface.
- **Impersonation** — denied-permission set and schema constraints are in place and tested;
  the flow that establishes one is not built.
- **`platform/audit`** (hash-chained), **`entitlements`**, **`notifications`**, **`files`**,
  **`i18n`** — not started.
- **App shell** — workspace/client switcher, command palette, settings, themes. Not started.
- **Permission cache** — 06 §3 specifies a 60s per-(session, organization) Redis cache with
  eager invalidation. The resolver currently recomputes on every call. That is correct but
  slower than specified; membership removal being immediate is a property of recomputation,
  so the cache must preserve it when added.

## 4. Two architectural corrections, recorded

### 4.1 `workspaces` scoping — wrong twice before it was right

**Attempt 1** (work item 1.1) restricted reads to `id = ANY(app_current_workspace_ids())`.
Circular: the accessible set is computed *by reading that table*, so every actor resolved to
an empty set — including the organization's owner, locked out of the tenant they had just
created.

**Attempt 2** (work item 1.4) used the plain organization predicate. Not circular, but it
left an authorization boundary defect: any session could enumerate every workspace row in
its own tenant with raw SQL regardless of its accessible set. A `client_guest` — someone
outside the tenant organization entirely — could read the agency's whole client list.

**Migration 0007** breaks the circle with a third setting rather than by weakening the
predicate. `app.workspace_scope` separates the two situations attempt 1 conflated: `'set'`
(the default, and every ordinary session) bounds reads to `app.workspace_ids`; `'all'` is
claimed by exactly two callers — the resolver, which runs before any session exists and must
read the team→workspace topology to compute the set at all, and a session whose actor
genuinely holds organization-wide workspace access, for whom the two are equivalent.

An architecture test pins that `withOrganizationScope` is defined once and called once.

### 4.2 An organization-scoped role is not automatically tenant-wide

`hasOrganizationScopedRole` was true for *any* organization-scoped assignment — including
`member`, whose entire permission set is `organization.organization:read`. A plain member
therefore resolved to an accessible set containing every workspace in the organization.

That set becomes `app.workspace_ids`, which is the predicate every workspace-scoped table is
filtered by, so this was materially worse than 4.1: not a leak of names, but of content. It
now requires an organization-scoped role granting at least one workspace-scoped permission,
computed by `grantsOrganizationWideWorkspaceAccess`.

Both are covered by `workspace-boundary.test.ts`, and both were verified to FAIL that suite
when the fix is reverted.

## 5. Carried from the Phase 0 gate, still open

1. **Nothing has been deployed.** No Docker daemon, no cloud credentials. The image has never
   been built; Terraform has never been applied.
2. **CI has never run on GitHub Actions.** Action versions, the `postgresql-16-pgvector` apt
   install and the gitleaks action are unproven on a hosted runner.
3. **No Terraform provider pinned** — open question #7 in [15-risks.md](15-risks.md).
4. **Compliance posture unanswered** — open question #1. Phase 1 proceeded on the documented
   assumption: GDPR-ready with `data_region` present and unused (it is on `organizations` as
   of migration 0004), SOC 2 evidence gathered continuously with the audit after GA.

## 6. The "intermittent" was a real race, now fixed

A test-stage failure that would not reproduce turned out not to be a flake at all.
`gates.test.ts` writes throwaway component fixtures into `packages/ui/src` (vitest will not
find them anywhere else), while `boundaries.test.ts` reads the whole source tree with
dependency-cruiser. Run in parallel, the reader walked a fixture the writer had already
deleted, and dependency-cruiser reported it by exiting non-zero with **no stdout** — which
surfaced as an unreadable JSON parse error in a different file.

Three things were wrong, and all three are fixed:

1. The suites raced. `fileParallelism: false` in that package's vitest config removes it by
   construction. Verified 6/6 at the concurrency that previously failed 2 runs in 3.
2. The failure was undiagnosable. The helper discarded the exit code and stderr, so a real
   error became "Unexpected end of JSON input". It now reports both.
3. **The suite was being cached.** `@growth-os/architecture-tests#test` reads the entire
   source tree, but turbo hashed only the package's own 39 files — so every cache hit
   replayed a pass computed against a different tree. That is how a genuine violation in
   `provisioning.ts` reached a green gate in work item 1.4. The task is now `cache: false`.

Item 3 is the significant one: it means the repo-wide enforcement has been silently stale on
every cache hit since Phase 0.
