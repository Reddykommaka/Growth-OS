# 12 — Deployment & DevOps Architecture

## 1. Environments

| Environment | Purpose | Data | Lifetime |
| --- | --- | --- | --- |
| **local** | Development | Seeded, synthetic | Developer machine |
| **test** | Automated suites | Ephemeral, per-run | Minutes |
| **preview** | One per pull request | Seeded, synthetic | Life of the PR |
| **staging** | Production-shaped rehearsal | Synthetic at production scale — **never a copy of production data** | Permanent |
| **production** | Live | Real | Permanent |

Configuration differs only by values, never by code paths. There is no `if (isProduction)`
branch in business logic; behaviour differences are expressed as configuration
(`packages/platform/config`), validated by the same Zod schema in every environment, and
the process **fails to boot** on a missing or invalid variable. A misconfiguration must
never become a silent runtime surprise at 3am.

Staging is deliberately not a production data copy: copying production data into a
lower-trust environment is the most common way customer PII escapes its controls.

## 2. Runtime topology

All three apps ship as **container images from one multi-stage Dockerfile**, deployed to a
managed container platform with managed PostgreSQL and managed Redis.

```
   ┌── CDN / WAF ──┐
   │               ▼
   │      web  (N replicas, autoscale on RPS + p95 latency)
   │      api  (N replicas, autoscale on RPS)
   │      link (redirect service — small, isolated, latency-critical)
   │      worker (M replicas per queue class, autoscale on queue depth)
   │               │
   │        PgBouncer (transaction pooling)
   │               ▼
   │      PostgreSQL primary  ──▶ read replica(s)
   │      Redis (persistence enabled)
   └──▶  Object storage (separate origin for user content)
```

Notes that are decisions, not incidentals:
- **Containers everywhere, not a platform-specific build.** The deployment target stays
  replaceable; nothing in the application knows what platform it runs on.
- **Workers autoscale on queue depth and oldest-job age**, not CPU. A backlog of delayed
  publishing jobs consumes almost no CPU while being an urgent customer-facing problem.
- **The link redirect service is separated early** — it is on a different availability and
  latency profile from the dashboard, and it must survive a dashboard incident.
- **PgBouncer in transaction mode** is why tenant context uses `SET LOCAL`
  ([06](06-identity-and-access.md) §4). The pooling choice and the isolation mechanism are
  the same decision.

## 3. CI pipeline

```
 PR opened
   ├─ install (frozen lockfile, cached)
   ├─ static:   tsc · biome · eslint · dependency-cruiser        ~2 min, fails fastest
   ├─ security: gitleaks · pnpm audit · OSV · CodeQL · licences
   ├─ unit + component  (sharded)
   ├─ integration  (real Postgres + Redis; migrations; RLS; authz matrix)
   ├─ migration checks  (forward apply on production-shaped schema + lint rules)
   ├─ build  (all apps, turbo remote cache)
   ├─ e2e  (Playwright, stubbed providers, sharded)
   └─ preview deploy + smoke
```

Merges to `main` are blocked unless every gate passes. Turbo's content-hash cache means an
unchanged package is not rebuilt or retested, so pipeline time tracks the size of the change
rather than the size of the repository.

## 4. Deployment and migrations

```
 merge to main → build & sign image → deploy staging → migrate → smoke
   → soak (30 min, error-budget watched) → manual approval → production
   → migrate (separate gated job) → rolling deploy → smoke → watch
```

- **Migrations are a discrete pre-deploy job** run with `growth_os_migrator`, never on
  application boot. Boot-time migration means N replicas racing the same DDL, and it means
  a bad migration takes the application down with it.
- **Expand/contract discipline** ([05](05-data-architecture.md) §11) is what makes rolling
  deploys safe: every migration must work with the *previous* application version, because
  both versions are live simultaneously during the roll.
- **Rollback** is a redeploy of the previous image. Because migrations are backward
  compatible by construction, a code rollback never requires a schema rollback — which is
  the property that makes rollback a five-minute operation instead of an incident.
- **Feature flags** decouple release from deploy; risky changes ship dark and are enabled
  per organization.
- **Images are signed and their SBOM published**; only signed images deploy.

## 5. Observability

**Traces** — OpenTelemetry across web → api → worker → database. A trace carries
`request_id`, `organization_id`, `actor_id`, `job_id` and `automation_run_id`, so a
customer's report of "my post didn't publish at 9am" is one trace query, not an
investigation.

**Metrics** — RED (rate, errors, duration) per endpoint and per job; plus the metrics that
are specific to this product and are the ones that actually predict customer pain:

- outbox lag (oldest unpublished event)
- queue depth and oldest job age, per queue
- scheduled-post publish punctuality (actual − scheduled)
- provider error rate and rate-limit-hit rate, per provider
- token-refresh failure rate and count of `degraded`/`expired` connections
- automation run failure rate, DLQ depth
- link-redirect p99
- rollup staleness
- database: connection saturation, replication lag, slow-query count, index-scan ratio

**Logs** — structured JSON (pino), correlated, with a redaction list applied at the
serializer so a secret cannot reach a log sink even if it reaches a log call.

**Errors** — Sentry with release tracking, source maps and ownership routing per module.

**Health** — `/healthz` (liveness, no dependencies) and `/readyz` (readiness: database,
Redis, migration version). Readiness must check the migration version, or a replica running
old code against a new schema will happily serve traffic.

**Alerting** — SLO-based and burn-rate driven, so pages correlate with customer impact
rather than with graphs moving:

| SLO | Target |
| --- | --- |
| Dashboard availability | 99.9% |
| API availability | 99.9% |
| Publish punctuality | 99% of posts within 60s of schedule |
| Link redirect p99 | < 50 ms |
| Webhook acknowledgement p99 | < 100 ms |

Paging alerts: error-budget burn, outbox lag, queue age, publish punctuality breach,
replication lag, DLQ growth, credential-decrypt failures, authorization-denial spike.
Everything else is a ticket. Every paging alert has a runbook in `docs/runbooks/`, and an
alert without one is deleted or downgraded.

## 6. Backup, recovery and continuity

| Concern | Target / mechanism |
| --- | --- |
| Postgres backups | Continuous WAL archiving + daily base backup; **PITR to any second within 30 days** |
| RPO / RTO | ≤ 5 minutes / ≤ 1 hour |
| **Restore drills** | Quarterly, into an isolated environment, timed and documented. An untested backup is a hypothesis, not a backup |
| Object storage | Versioning + cross-region replication; lifecycle rules to cold storage |
| Redis | Treated as **rebuildable**, never a source of truth. Losing Redis costs throughput, not data — this is a design constraint on every feature |
| Cold data | Detached partitions exported to Parquet in object storage before drop |
| Tenant-level restore | Supported via PITR into a scratch database and selective export — a customer deleting their own data by mistake is far more likely than a regional outage |
| Multi-region | Not in scope initially; `organizations.data_region` exists from the first migration so residency is a routing change later |

## 7. Infrastructure as code

Terraform, with `envs/{staging,production}` composed from shared modules. Remote state with
locking. Every infrastructure change is a reviewed PR with a `plan` posted to it. Manual
console changes are drift and are reverted — the console is for reading, not writing.

## 8. Operational routine

| Cadence | Activity |
| --- | --- |
| Continuous | SLO dashboards, error budget, queue health |
| Daily | Failed job and DLQ review; degraded-connection review |
| Weekly | Dependency upgrade PRs; slow-query review; cost review |
| Monthly | Access review (who has production access and why); alert-noise review |
| Quarterly | Restore drill; chaos drill; index and partition audit; retention job verification; key rotation |
| Per incident | Timeline from the audit chain and traces; blameless post-mortem; action items tracked as issues |

## 9. Deferred, deliberately

Kubernetes, service mesh, multi-region active-active and a data warehouse are all deferred.
Each solves a problem this system does not yet have, and each adds an operational surface
that must be staffed. The architecture does not preclude any of them: containers make the
platform portable, the event spine makes extraction possible, and the `AnalyticsQueryPort`
makes a warehouse a swap rather than a rewrite.
