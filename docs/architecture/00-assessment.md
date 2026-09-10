# 00 — Current Project Assessment

*Assessment performed 2026-09-10 against `Reddykommaka/Growth-OS`.*

## 1. What is actually in the workspace

The repository is **empty**. This was verified directly rather than assumed:

| Check | Result |
| --- | --- |
| Working tree (`/home/user/Growth-OS`) | Contains only `.git/` — zero tracked or untracked files |
| `git log` | `fatal: your current branch ... does not have any commits yet` |
| `git ls-remote --heads origin` | No output — no branches exist on the remote |
| GitHub API (`Reddykommaka/Growth-OS`) | `size: 0`, `default_branch: main` (unborn), created 2026-09-10T05:35:46Z, public, no issues/PRs |
| Current branch | `claude/growth-os-production-arch-rnbqyv` (unborn, local only) |

### Consequences

1. **There is no existing work to preserve.** The directive's instruction not to destroy
   useful existing work is satisfied vacuously — there is none.
2. **There is no reusable code, and no conflicts.** Every technology choice is open.
3. **There are no implicit constraints** from a prior stack, schema, or deployment target.
4. **The repository is public.** This is a live concern from the first commit: no secrets,
   no internal hostnames, no customer data may ever enter history. Addressed in
   [10-security-architecture.md](10-security-architecture.md).

## 2. Existing technologies

None in the repository. The following is the toolchain available in the build/dev
environment, verified by invocation — the stack recommendation is constrained to what
demonstrably runs here.

| Tool | Version present | Relevance |
| --- | --- | --- |
| Node.js | 22.22.2 | Primary runtime target |
| pnpm | 10.33.0 | Workspace/package manager |
| npm / yarn / bun / deno | 10.9.7 / 1.22.22 / 1.3.11 / — | Available, not selected |
| PostgreSQL **client and server binaries** | 16.13 (`initdb`, `pg_ctl`, `pg_dump` present) | Primary datastore; real-DB tests runnable locally |
| Redis CLI | 7.0.15 | Client only — no server binary present |
| Docker CLI | 29.3.1 — **daemon not running** | Cannot use Testcontainers in this environment |
| Go / Rust / Java | 1.24.7 / 1.94.1 / OpenJDK 21 | Available; not required by the recommendation |
| Playwright browsers | Pre-provisioned at `/opt/pw-browsers` | E2E runnable without downloads |
| Resources | 4 vCPU, 15 GiB RAM, ~30 GiB free disk | Adequate for full test suites |

### Environment constraints that shape the design

- **No Docker daemon in this session.** The test harness must not *require* containers.
  Because full PostgreSQL server binaries are present, the integration-test harness will
  spin up a throwaway cluster with `initdb`/`pg_ctl` (see
  [11-testing-architecture.md](11-testing-architecture.md)). Testcontainers is supported as an
  optional path where a daemon exists, never as the only path.
- **No Redis server binary.** Redis-dependent code must be exercised through an
  in-process fake in unit/integration tests, with a real Redis only in CI and staging.
  This is a design requirement on the queue and rate-limiter abstractions, not an
  afterthought.
- **Outbound traffic is proxied** with a custom CA bundle. Anything that makes network
  calls (package installs, provider SDKs, CI runners) must respect `HTTPS_PROXY` and
  `NODE_EXTRA_CA_CERTS`. No code may disable TLS verification.

## 3. Library landscape verified at assessment time

Versions resolved live from the registry on 2026-09-10, so the stack is pinned to what
actually ships today rather than what was current at some earlier point:

| Package | `latest` | Note |
| --- | --- | --- |
| `next` | 16.3.4 | Stable |
| `react` | 19.3.0 | Stable |
| `typescript` | 7.0.2 | Native-port compiler line is now stable (`6.0.0-beta` remains on the `beta` tag) |
| `drizzle-orm` | 0.45.2 | Still pre-1.0 — treated as a risk with an explicit mitigation |
| `prisma` | `latest` = 8.0.0-rc.13, `prev` = 7.10.0 | Latest stable line is mid-major-transition |
| `vitest` | 5.0.0 | Stable |
| `playwright` | 1.63.0 | Stable |
| `zod` | 4.6.1 | Stable |
| `bullmq` | 6.3.4 | Stable |
| `fastify` | 5.12.3 | Stable |
| `tailwindcss` | 4.3.3 | CSS-variable-first theming |
| `stripe` | 22.6.2 | Stable |
| `@opentelemetry/sdk-node` | 0.222.0 | Still 0.x by convention |
| `turbo` | 2.10.12 | Stable |
| `@biomejs/biome` | 2.5.12 | Stable |

## 4. Assessment conclusion

This is a clean greenfield with an unusually capable local toolchain. The correct move is
**not** to start generating application files. It is to fix the tenancy model, the module
boundaries, the data model and the event/attribution spine first, because those four are
the decisions that cannot be cheaply reversed once data exists in production.

Everything else in this document set follows from that.
