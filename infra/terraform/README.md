# Infrastructure

Terraform, per [12-devops-architecture.md](../../docs/architecture/12-devops-architecture.md) §7.
Every infrastructure change is a reviewed PR with a `plan` posted to it. Manual console
changes are drift and are reverted — the console is for reading, not writing.

## Layout

```
modules/
  app_service/      one containerised app: image, scaling policy, health probes, secrets
  postgres/         managed PostgreSQL: version, PITR window, replicas, extensions
  redis/            managed Redis: persistence, eviction policy
  object_storage/   two buckets — private application storage, and the SEPARATE
                    user-content origin (10-security-architecture.md §2)
envs/
  staging/          composes the modules for staging
```

Production is deliberately absent until staging has run for long enough to be trusted.
Adding it is a copy of `envs/staging` with different sizing and a separate state backend.

## Provider

**No provider is pinned yet.** Deployment target is open question #7
([15-risks.md](../../docs/architecture/15-risks.md) §3): the architecture is intentionally
portable — containers, managed PostgreSQL, managed Redis, S3-compatible storage — and every
managed platform offers all four.

The module *interfaces* here are provider-agnostic and are the part that matters: they fix
what each environment must supply, so choosing a provider becomes filling in resource blocks
rather than redesigning. Committing to a provider before that decision is made would be
guessing, and rewriting it later costs more than waiting.

## State

Remote state with locking, one backend per environment. State contains connection strings
and must be treated as secret: encrypted at rest, access limited to CI and platform
engineers.

## What is NOT in Terraform

Application secrets. Terraform provisions the secret *store*; values are set out of band and
injected as environment variables at runtime. A secret in state is a secret in a file that
many people can read.
