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

## 4. One architectural correction, recorded

**`workspaces` is organization-scoped (level 2), not restricted by the accessible set.**

Work item 1.1 gave it a policy requiring `id = ANY(app_current_workspace_ids())`, intending
to stop a `client_guest` learning that the agency's other clients exist. That is circular:
the accessible set is computed *by reading that table*, so a policy demanding the set makes
the set underivable. Every actor resolved to an empty set — including the organization's
owner, locked out of the tenant they had just created.

[05-data-architecture.md](05-data-architecture.md) §3 already settles it: level 3 is a table
"additionally [carrying] `workspace_id NOT NULL`". `workspaces` has no such column — it *is*
the workspace — so it is level 2.

**Residual risk, stated plainly:** a session with the application check bypassed could
enumerate workspace *names* within its own organization. It cannot reach another tenant, and
it cannot read any workspace's contents. Documented in `db/policies/workspaces.sql` and
pinned by a test that asserts it as a fact, not as a desired property — a test claiming the
row was hidden would pass only until someone checked.

## 5. Carried from the Phase 0 gate, still open

1. **Nothing has been deployed.** No Docker daemon, no cloud credentials. The image has never
   been built; Terraform has never been applied.
2. **CI has never run on GitHub Actions.** Action versions, the `postgresql-16-pgvector` apt
   install and the gitleaks action are unproven on a hosted runner.
3. **No Terraform provider pinned** — open question #7 in [15-risks.md](15-risks.md).
4. **Compliance posture unanswered** — open question #1. Phase 1 proceeded on the documented
   assumption: GDPR-ready with `data_region` present and unused (it is on `organizations` as
   of migration 0004), SOC 2 evidence gathered continuously with the audit after GA.

## 6. One unreproduced intermittent

A single run of the test stage under concurrency failed parsing `dependency-cruiser`'s stdout
as JSON. Not reproduced in four subsequent runs (one standalone, three full). Recorded rather
than assumed fixed: CI runs under load too, and a test that fails once in five is a defect
whether or not it is convenient.
