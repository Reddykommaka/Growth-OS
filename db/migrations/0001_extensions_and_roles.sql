-- 0001 — Extensions and database roles.
--
-- This migration establishes the security posture the entire multi-tenant model rests on
-- (06-identity-and-access.md §4, ADR-0003). It creates NO tables: Phase 0 builds the
-- machine that enforces the architecture, not the product schema.
--
-- Forward-only and immutable once merged (05-data-architecture.md §11).

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
-- pgcrypto   — gen_random_bytes for token generation; digest() for hash chains.
-- citext     — case-insensitive email and slug comparison without lower() everywhere.
-- pg_trgm    — fuzzy contact/company lookup (05-data-architecture.md §6 rule 5).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- vector — embeddings for intelligence-layer retrieval (16-intelligence-architecture.md §4).
-- Created here rather than in the Phase 4 migration that first uses it, so the deployment
-- prerequisite surfaces now instead of blocking a later phase. Requires the pgvector
-- extension to be installed on the server (postgresql-16-pgvector, or enabled in the
-- managed provider's console). See docs/runbooks/database-prerequisites.md.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
  ELSE
    RAISE EXCEPTION
      'The "vector" extension is not available on this server. %',
      'Install postgresql-<version>-pgvector or enable pgvector in the managed provider. '
      'See docs/runbooks/database-prerequisites.md.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
-- Two roles, and the separation between them is load-bearing:
--
--   growth_os_app       every request and every job. NOBYPASSRLS, and this is not
--                       configurable at runtime. A missed authorization check in the
--                       application is then a permissions bug, not a cross-tenant breach.
--
--   growth_os_migrator  BYPASSRLS, used ONLY by the migration job, which never runs inside
--                       an application process (12-devops-architecture.md §4).
--
-- CI asserts growth_os_app has rolbypassrls = false
-- (11-testing-architecture.md §4, structural test 2).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'growth_os_app') THEN
    CREATE ROLE growth_os_app NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'growth_os_migrator') THEN
    CREATE ROLE growth_os_migrator NOLOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  -- growth_os_relay — the outbox relay (ADR-0007, migration 0015).
  --
  -- It reads across every organization by design, so it cannot run under the tenant
  -- predicate. Neither existing role will do: growth_os_app would need BYPASSRLS, which would
  -- dissolve the isolation model to solve a background-job problem, and growth_os_migrator
  -- owns every table and holds DDL rights a long-lived worker process has no business
  -- carrying. BYPASSRLS buys one thing here and the role holds nothing else — no CREATE on the
  -- schema, and grants on only the tables the relay touches, given in 0015.
  --
  -- CREATED HERE, NOT IN 0015, because role creation is provisioning: 0015 runs as
  -- growth_os_migrator, which is NOCREATEROLE, so it cannot create a role at all. This
  -- migration is the bootstrap, applied by the provisioning superuser, and it is the only
  -- place in the schema where a role can come into existence.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'growth_os_relay') THEN
    CREATE ROLE growth_os_relay NOLOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Belt and braces: re-assert the attributes even if the roles pre-existed from an older
-- provisioning script. The application role must never acquire BYPASSRLS by accident.
ALTER ROLE growth_os_app       NOBYPASSRLS NOSUPERUSER;
ALTER ROLE growth_os_migrator  BYPASSRLS   NOSUPERUSER;
ALTER ROLE growth_os_relay      BYPASSRLS   NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- ---------------------------------------------------------------------------
-- Schema privileges
-- ---------------------------------------------------------------------------
-- The application may use the schema but must not create in it: schema changes belong to
-- migrations, run by the migrator, reviewed as artefacts.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT  USAGE  ON SCHEMA public TO growth_os_app;
GRANT  ALL    ON SCHEMA public TO growth_os_migrator;

-- Default privileges for objects the migrator creates later. Note the deliberate absence of
-- a blanket grant: append-only tables such as audit_events withhold UPDATE and DELETE from
-- the application role in their own migration (05-data-architecture.md §9), and a default
-- grant here would silently undo that.
ALTER DEFAULT PRIVILEGES FOR ROLE growth_os_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO growth_os_app;
ALTER DEFAULT PRIVILEGES FOR ROLE growth_os_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO growth_os_app;

-- ---------------------------------------------------------------------------
-- Tenant context helpers
-- ---------------------------------------------------------------------------
-- Every RLS policy reads these. They are STABLE (not IMMUTABLE) because the setting can
-- change between statements, and they return NULL rather than raising when unset — which is
-- what makes an unset context fail CLOSED: a NULL comparison is false, so a query with no
-- tenant context matches zero rows (06-identity-and-access.md §5).

CREATE OR REPLACE FUNCTION app_current_organization_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- The accessible-workspace set, resolved by the authorization layer from the actor's
-- organization, team and workspace role assignments and handed to the database as a
-- concrete list. Teams are deliberately NOT part of any RLS predicate: resolving them here
-- would put a three-way join in every policy on every query, and would break as soon as a
-- workspace is served by two teams (ADR-0003).
CREATE OR REPLACE FUNCTION app_current_workspace_ids() RETURNS uuid[]
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT COALESCE(
     NULLIF(current_setting('app.workspace_ids', true), '')::uuid[],
     ARRAY[]::uuid[]
   ) $$;

GRANT EXECUTE ON FUNCTION app_current_organization_id() TO growth_os_app;
GRANT EXECUTE ON FUNCTION app_current_user_id()         TO growth_os_app;
GRANT EXECUTE ON FUNCTION app_current_workspace_ids()   TO growth_os_app;

-- ---------------------------------------------------------------------------
-- Migration ledger
-- ---------------------------------------------------------------------------
-- Applied migrations are recorded with a checksum. An already-applied migration whose
-- content changed is a merge accident, and the runner refuses to proceed rather than
-- leaving two environments silently divergent (05-data-architecture.md §11).
CREATE TABLE IF NOT EXISTS schema_migrations (
  name        text        PRIMARY KEY,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer     NOT NULL
);

-- Readable by the application so /readyz can compare the deployed schema version against
-- what the running code expects (12-devops-architecture.md §5).
GRANT SELECT ON schema_migrations TO growth_os_app;

-- The migration job needs the ledger it writes.
--
-- This migration is the bootstrap: it CREATEs growth_os_migrator, so it cannot itself run
-- as that role, and it is applied by the provisioning superuser. Everything from 0002
-- onward runs as the migrator, which therefore does not own this table and has no implicit
-- privilege on it. Without this grant the job cannot record the first migration it applies
-- — it fails on 0002, before any schema exists to inspect.
--
-- SELECT and INSERT only, deliberately. A runner that can UPDATE or DELETE its own history
-- can be made to re-apply a migration silently, which is exactly the divergence the
-- checksum column exists to catch.
GRANT SELECT, INSERT ON schema_migrations TO growth_os_migrator;
