# Runbook — Database prerequisites

Applies to every environment that runs migration `0001_extensions_and_roles.sql`:
local development, CI, staging and production.

## Required PostgreSQL version

**16 or later.** The data architecture depends on declarative `RANGE` partitioning, RLS with
`FORCE`, generated columns and `FOR UPDATE SKIP LOCKED`
([05-data-architecture.md](../architecture/05-data-architecture.md)).

## Required extensions

| Extension | Ships with PostgreSQL? | Used for |
| --- | --- | --- |
| `pgcrypto` | Yes (contrib) | Token generation, audit hash chains |
| `citext` | Yes (contrib) | Case-insensitive email and slug comparison |
| `pg_trgm` | Yes (contrib) | Fuzzy contact and company lookup |
| **`vector` (pgvector)** | **No — must be installed** | Intelligence-layer retrieval ([16](../architecture/16-intelligence-architecture.md) §4) |

`pgcrypto`, `citext` and `pg_trgm` are in `postgresql-contrib`, present in essentially every
distribution and managed offering.

### pgvector

`vector` is the one prerequisite **not** satisfied by a default install. Migration 0001
creates it and **fails with an explicit message** if it is unavailable, rather than deferring
the problem to the Phase 4 migration that first needs it.

| Environment | How to provide it |
| --- | --- |
| Debian/Ubuntu | `apt-get install postgresql-16-pgvector` |
| Alpine / source | Build from https://github.com/pgvector/pgvector |
| Docker | Use `pgvector/pgvector:pg16`, or install into your own image |
| AWS RDS / Aurora | Supported natively; nothing beyond `CREATE EXTENSION` |
| Google Cloud SQL | Enable the `vector` flag on the instance |
| Azure Database | Add `vector` to `azure.extensions` |
| Neon / Supabase / Render | Available by default |

**CI**: the image used by the integration-test job must include the pgvector package.
Without it, migration 0001 fails at `CREATE EXTENSION` with a message pointing here.

## Roles

Migration 0001 creates two roles, and the separation between them is load-bearing
([06-identity-and-access.md](../architecture/06-identity-and-access.md) §4):

| Role | Attributes | Used by |
| --- | --- | --- |
| `growth_os_app` | `NOBYPASSRLS`, not superuser, cannot create roles or databases | Every request and every job |
| `growth_os_migrator` | `BYPASSRLS` | The migration job **only** — never an application process |

Both are created `NOLOGIN`. Each environment grants `LOGIN` and sets credentials through its
secret manager; a migration that set a password would put one in version control.

**CI asserts** `growth_os_app` has `rolbypassrls = false`. If that assertion ever fails,
every tenant-isolation policy in the system is inert — treat it as a Sev-1.

## Verifying an environment

```sql
SELECT extname FROM pg_extension
 WHERE extname IN ('pgcrypto','citext','pg_trgm','vector') ORDER BY extname;
-- expect: citext, pg_trgm, pgcrypto, vector

SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
 WHERE rolname LIKE 'growth\_os\_%' ORDER BY rolname;
-- expect: growth_os_app (f, f), growth_os_migrator (t, f)

SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1;
-- the deployed schema version, also reported by /readyz
```

## Local development without a running server

Integration tests do not need a PostgreSQL *service*: `@growth-os/testing` bootstraps a
throwaway cluster from the PostgreSQL **binaries** with `initdb`/`pg_ctl`
([11-testing-architecture.md](../architecture/11-testing-architecture.md) §2). Install
`postgresql-16` for the binaries; nothing needs to be enabled or running.

Set `PG_BIN` if the binaries live somewhere unusual (Homebrew, Nix).

Running as `root` (common in CI containers) is handled: PostgreSQL refuses to start as root,
so the harness drives `initdb`/`pg_ctl` through an unprivileged account (`postgres`, falling
back to `nobody`). If neither account exists the harness fails with an explicit message
rather than a confusing permissions error.
