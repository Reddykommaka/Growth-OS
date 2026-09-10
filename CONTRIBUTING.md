# Contributing

Read [docs/README.md](docs/README.md) first. The architecture is not a suggestion — most of
it is enforced by CI, and a change that fights the enforcement is usually a change that
needs an ADR rather than a workaround.

## Getting set up

```bash
pnpm install
git config core.hooksPath .githooks   # pre-commit secret, format and migration checks
pnpm run build
pnpm run test
```

Integration tests need the PostgreSQL **binaries** (not a running server) plus pgvector —
see [docs/runbooks/database-prerequisites.md](docs/runbooks/database-prerequisites.md). The
harness starts its own throwaway cluster; nothing needs to be enabled on your machine.

```bash
pnpm run lint              # 7 gates: format, code, boundaries, file size, client env,
                           # migrations, schema version
pnpm run typecheck
pnpm run test              # unit + component
pnpm run test:integration  # real PostgreSQL
pnpm run e2e               # Chromium: contrast, landmarks, focus
```

## The rules CI enforces

You will not get far fighting these, so it is worth knowing why they exist.

| Rule | Where it comes from |
| --- | --- |
| `domain/` imports nothing above it; `application/` never imports `infrastructure/` | [03](docs/architecture/03-repository-structure.md) §2 |
| Apps import a module's `./contracts` only | [01](docs/architecture/01-overview.md) §3 principle 1 |
| No ORM, Redis, queue or provider SDK in `domain/` or `application/` | [03](docs/architecture/03-repository-structure.md) §2 |
| Model provider SDKs only inside `packages/integrations/*` | [ADR-0013](docs/adr/0013-model-provider-abstraction.md) |
| No `any`, no non-null assertion outside tests | [01](docs/architecture/01-overview.md) §3 principle 10 |
| Files under 400 lines | [03](docs/architecture/03-repository-structure.md) §5 |
| `timestamptz` only; money as integer minor units; no native enums | [05](docs/architecture/05-data-architecture.md) §1, [ADR-0012](docs/adr/0012-money-and-ledger.md) |
| Every tenant-scoped table has RLS enabled **and** forced, with an explicit `WITH CHECK` | [06](docs/architecture/06-identity-and-access.md) §4 |
| Every foreign key has a covering index | [05](docs/architecture/05-data-architecture.md) §6 |
| Components pass `axe` and keyboard tests in both themes | [13](docs/architecture/13-design-system.md) §5 |

If a rule is wrong, change the rule in a PR with the reasoning — do not add a suppression.
A suppression with no recorded reason is one someone widens later.

## Review requirements

Normal changes need one reviewer. **Two reviewers are required** for anything touching:

- `packages/platform/authn` or `packages/platform/authz`
- `db/policies/` or any migration that creates, alters or drops an RLS policy
- Marketplace money: orders, payments, commissions, payouts, the ledger
- Any prompt or AI capability that reads untrusted input ([ADR-0016](docs/adr/0016-ai-governance.md))

## Pull requests

The template asks four questions. They are not ceremony — they are the questions that catch
the expensive mistakes:

1. **Which module owns this?** Two owners means you need an event, not a shared table.
2. **Which permission gates it?** Every state change asserts one. "None" is an answer only
   for genuinely public surfaces.
3. **What happens when it fails?** Every subsystem documents its failure mode; add yours.
4. **Does it need a threat-model note?** Required for authn/authz, money, file handling and
   PII.

Keep PRs small enough to review properly. A bug fix ships with a regression test that fails
without the fix.

## Commits

Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). Explain
**why** in the body, not what — the diff already says what. If you discovered something
non-obvious, write it down; the next person will hit the same thing.

## Migrations

Forward-only, immutable once merged, expand/contract always — every migration must be safe
against the **previous** application version, because deploys are rolling. Add a migration
and regenerate the schema version:

```bash
node tools/scripts/generate-schema-version.mjs
```

CI fails if you forget: `/readyz` would otherwise accept a database missing your migration.

## Adding a dependency

Justify it in the PR description: what it does, why not the standard library, its
maintenance signal, its transitive weight. Exact versions only — no `^` or `~`. Copyleft
licences are blocked in application packages.

## ADRs

Write one when a decision is expensive to make and expensive to reverse. Copy
[docs/adr/TEMPLATE.md](docs/adr/TEMPLATE.md). The consequences section **must** include the
negative ones; an ADR that only lists benefits is marketing, not a record. Accepted ADRs are
immutable — reverse one with a new ADR that supersedes it.
