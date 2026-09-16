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

## 7. Work item 1.9 — the credential bootstrap defect (ADR-0018)

Invitations and API keys are presented by somebody who is not yet inside a tenant. Both live
in tenant-scoped tables (`invitations`, `api_keys`, migration 0005) whose RLS policy fails
closed with no `app.organization_id`. So reading the row required knowing the organization,
and the only way to learn the organization was to read the row — the same circularity
migration 0007 resolves for the accessible-workspace set.

It was caught by a test, not by review: 11 of 22 invitation cases failed, every one returning
`invalid`, because acceptance ran through `withoutTenantContext` — whose own suite asserts it
"still sees ZERO tenant rows". The code could not have worked, and the guarantee it violated
was already documented and tested.

The fix is [ADR-0018](../adr/0018-credentials-carry-their-tenant.md): the credential names
its tenant, as an untrusted routing hint, and the row is then read under RLS inside that
tenant's scope. A relaxed policy and a `SECURITY DEFINER` resolver were both considered and
rejected there. **The system still contains no code path that bypasses RLS.**

Two consequences worth recording:

1. **The wrong-organization attack became expressible, and is now tested actively.** Before,
   "you cannot choose the organization" was true because there was no parameter. Now there
   is one — and rewriting it is refused twice over, by the policy and by the hash. Both
   directions are asserted, including that the genuine credential still works afterwards.
2. **`withOrganizationScope` grew from one caller to three, and simultaneously got
   narrower.** Its capability is now a required argument rather than a fixed `'all'`. Two of
   the three callers pass `'set'` with an empty workspace set and therefore cannot see a
   workspace-scoped row at all. The architecture test pins the caller list *and* the shorter
   list permitted to ask for `'all'`, and asserts that both sanctioned sites genuinely do ask
   — so the rule cannot start passing because the call disappeared.

### Still open after 1.9

- Test files and `src/__testing__/` are excluded from `tsc --build`, so **no test file in the
  repository is typechecked**. Vitest transforms them with esbuild, which strips types
  without checking them. A test asserting against a field that no longer exists would run and
  pass. This predates 1.9 and is not fixed here.
- Invitation delivery is a contract with no production implementation; `platform/notifications`
  is still pending, and the production notifier should enqueue through the outbox (ADR-0007)
  rather than send inline.

## 8. Work items 1.10–1.11 — the identity gate, and a resend that was not settled

### The team-membership gap (1.10)

The identity authorization suite covered actors holding a workspace role *directly*; its
fixture said so in a comment — *"Not a member of pod A, not org-scoped."* So no authenticated
user in that suite reached a workspace through **team membership**, which is the one path the
three-level model exists for and the one that behaves differently.

Teams are deliberately absent from the RLS predicate (05 §3, 06 §3). A team member holds no
workspace-scoped role at all; their accessible set is *computed* by expanding
team → workspaces-owned and team → workspaces-granted, and the result is then handed to the
database as `app.workspace_ids`. Every other authenticated actor is authorised by a row that
either exists or does not. This one is authorised by a derivation, and a derivation fails in
ways a lookup cannot:

- **over-inclusion** — a set wider than the team's reach, which the database then faithfully
  honours, because `app.workspace_ids` *is* the predicate;
- **staleness** — access surviving a removal, if the set were computed once and cached
  against the session rather than re-derived.

Both are now asserted from real authenticated sessions, including that a member of no team
derives an empty set (the `member` role is organization-scoped, which is the exact shape that
once handed a plain member every workspace in the tenant — work item 1.5).

The suite was verified against the bugs it exists for rather than merely observed to pass:
granting team members every organization workspace fails 4 of 10; dropping
`team_workspace_access` from the expansion fails 4 of 10.

### Resend was a read-then-write (1.11)

`rotateToken` was an unconditional `UPDATE ... WHERE id = $1`, and `resendInvitation` read the
row, decided it was pending, and then wrote. That is the pattern this codebase settles
everywhere else with a conditional `UPDATE`, and three failures followed — none of them
visible in a sequential test:

1. **Two operators resending at once.** Both writes succeeded and the last writer's hash
   survived, so both were handed a token they believed was live. One invitee received a link
   that was dead before it was sent, and nothing indicated which.
2. **A resend racing an acceptance.** The pending check is a read. An acceptance landing
   between it and the write minted a fresh token for an already-consumed invitation.
3. **A resend racing a revocation** — the security-relevant one. A blind write gave a revoked
   invitation a live token hash and a fresh expiry: a revocation that did not fully take, on a
   row an operator had already been told was dead.

`rotateToken` is now a compare-and-set pinned to the hash the caller read *and* to the row
still being pending. The loser is told, and notifies nobody.

### Two tests that were flaky rather than wrong-but-stable

Both asserted **which writer wins a race** instead of the invariant that holds either way.
This is worth recording because it is a failure mode that looks like a passing test:

- The new simultaneous revoke/resend case asserted "not both succeed" — but a resend landing
  first, followed by a revoke, is a legitimate sequence in which both do. It now asserts the
  end state (if the row is revoked, no token ever issued for it is redeemable), with both
  orderings *also* pinned deterministically so neither branch can quietly stop being covered.
- `concurrent rotations keep the first revocation time` asserted the **minimum** of the two
  candidate stamps, assuming the zero-grace rotation wrote first. `COALESCE(revoked_at, $3)`
  guarantees the *first writer's* stamp survives, which under concurrency may be either. Split
  into a deterministic write-once test — long grace first, so a naive "keep the earliest"
  implementation fails it — and a concurrency test asserting the stamp is one of the two
  candidates and never moves afterwards.

Both surfaced only by running the gate repeatedly. Each affected suite was then run six times
and the integration gate three times, with no flake.

### Still open after 1.11

- Test files and `src/__testing__/` remain excluded from `tsc --build`, so **no test file is
  typechecked**. Unchanged from §7.
- Invitation delivery is still a contract with no production implementation.
