-- 0004 — Organizations, teams and workspaces.
--
-- Phase 1, per 05-data-architecture.md §2-§3 and 06-identity-and-access.md §3-§4.
--
-- This file is where tenant isolation actually begins, so its policies are the most
-- security-sensitive SQL in the repository and are reviewed as such (CONTRIBUTING.md
-- second-reviewer rule).
--
-- The hierarchy is organization → team → workspace, but the ISOLATION PREDICATE is written
-- against organization_id and workspace_id only. Teams are deliberately absent from every
-- policy (05 §3): team membership is resolved in the application layer into the actor's
-- accessible-workspace set and handed to the database as app.workspace_ids. Putting team_id
-- into the predicate would mean a three-way join inside every policy on every query, and it
-- would break the moment a workspace is served by two teams — which team_workspace_access
-- exists to support.

-- ---------------------------------------------------------------------------------------
-- organizations — the tenant root
-- ---------------------------------------------------------------------------------------
-- NOTE: this table's tenant column is `id`, not `organization_id`. That makes it the one
-- table the catalogue-driven structural check cannot discover by column name, so the check
-- was extended in the same change that added this table to treat the tenant root explicitly.
-- The tenant root being the single table exempt from the automatic sweep is precisely the
-- kind of gap that stays open for years.
CREATE TABLE organizations (
  id                uuid        PRIMARY KEY,
  slug              text        NOT NULL,
  name              text        NOT NULL,
  -- Agency vs. direct business drives the dual onboarding paths and whether the team layer
  -- is shown in the UI at all (14-roadmap.md Phase 1).
  kind              text        NOT NULL CHECK (kind IN ('agency', 'business')),
  status            text        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'suspended', 'closing', 'closed')),
  billing_email     citext      NULL,
  default_timezone  text        NOT NULL DEFAULT 'UTC',
  default_locale    text        NOT NULL DEFAULT 'en',
  -- Present and unused from Phase 1 (20-phase-0-gate.md §3.4). Residency is cheap to carry
  -- now and expensive to retrofit once rows exist in one region.
  data_region       text        NOT NULL DEFAULT 'global'
                                CHECK (data_region IN ('global', 'eu', 'us')),
  -- Organization-wide security policy, enforced server-side at session establishment.
  mfa_required      boolean     NOT NULL DEFAULT false,
  sso_required      boolean     NOT NULL DEFAULT false,
  settings          jsonb       NOT NULL DEFAULT '{}',
  metadata          jsonb       NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz NULL
);

CREATE UNIQUE INDEX organizations_slug_key ON organizations (slug) WHERE deleted_at IS NULL;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON organizations
  USING      (id = app_current_organization_id())
  WITH CHECK (id = app_current_organization_id());

-- ---------------------------------------------------------------------------------------
-- teams — the staffing/access layer
-- ---------------------------------------------------------------------------------------
CREATE TABLE teams (
  id              uuid        PRIMARY KEY,
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  slug            text        NOT NULL,
  name            text        NOT NULL,
  description     text        NULL,
  -- Every organization gets one default team so the direct-business onboarding path never
  -- has to reason about a null team, and the UI can collapse the layer when it is the only
  -- one and carries no information.
  is_default      boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz NULL
);

CREATE UNIQUE INDEX teams_org_slug_key
  ON teams (organization_id, slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX teams_org_default_key
  ON teams (organization_id) WHERE is_default AND deleted_at IS NULL;
CREATE INDEX teams_organization_id_idx ON teams (organization_id);

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON teams
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

-- ---------------------------------------------------------------------------------------
-- workspaces — THE resource boundary
-- ---------------------------------------------------------------------------------------
CREATE TABLE workspaces (
  id                uuid        PRIMARY KEY,
  organization_id   uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  -- The owning team. Nullable: a workspace may sit directly under the organization, and a
  -- direct business never needs the layer at all.
  team_id           uuid        NULL REFERENCES teams (id) ON DELETE SET NULL,
  slug              text        NOT NULL,
  name              text        NOT NULL,
  kind              text        NOT NULL DEFAULT 'client'
                                CHECK (kind IN ('client', 'internal', 'brand')),
  status            text        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'archived')),
  timezone          text        NOT NULL DEFAULT 'UTC',
  locale            text        NOT NULL DEFAULT 'en',
  -- The agency's own reference for this client (their CRM id, account code).
  client_reference  text        NULL,
  settings          jsonb       NOT NULL DEFAULT '{}',
  metadata          jsonb       NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz NULL
);

CREATE UNIQUE INDEX workspaces_org_slug_key
  ON workspaces (organization_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX workspaces_organization_id_idx ON workspaces (organization_id);
CREATE INDEX workspaces_team_id_idx ON workspaces (team_id) WHERE team_id IS NOT NULL;

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;

-- ORGANIZATION-SCOPED (05-data-architecture.md §3 level 2), not accessible-set restricted.
--
-- Level 3 in that taxonomy is "additionally workspace_id NOT NULL; RLS adds membership of
-- the workspace via the actor's accessible-workspace set". This table has no workspace_id
-- column — it IS the workspace — so it is level 2, and the predicate is the plain tenant
-- one.
--
-- An earlier version of this migration added `AND id = ANY(app_current_workspace_ids())` to
-- USING, reasoning that it would stop a client_guest learning the agency's other clients
-- exist. That is circular and cannot work: the accessible set is computed BY READING THIS
-- TABLE (a team's owned workspaces come from workspaces.team_id), so a policy requiring the
-- set makes the set underivable. The resolver returned an empty set for every actor,
-- including the organization's owner.
--
-- Where that containment actually lives:
--   - The authorization engine denies any workspace outside the resolved set, with reason
--     `workspace_not_accessible`, before a query is issued.
--   - Every workspace-SCOPED table (one carrying workspace_id — content, campaigns,
--     reports, from Phase 3 on) is level 3 and IS restricted by the set in RLS. A guest
--     cannot read another client's work even if the application check were bypassed.
--
-- What is given up: with the application check bypassed, a session could enumerate
-- workspace NAMES inside its own organization. Not another tenant's — the tenant boundary
-- is unaffected. That residual is the documented level-2 posture for this table.
CREATE POLICY tenant_isolation ON workspaces
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

-- ---------------------------------------------------------------------------------------
-- organization_members
-- ---------------------------------------------------------------------------------------
CREATE TABLE organization_members (
  id              uuid        PRIMARY KEY,
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status          text        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  -- An agency's own staff vs. a client's reviewer. Drives whether the member is offered the
  -- team layer at all, and is the coarse guard behind client_guest.
  member_type     text        NOT NULL DEFAULT 'staff'
                              CHECK (member_type IN ('staff', 'client')),
  title           text        NULL,
  invited_by      uuid        NULL REFERENCES users (id) ON DELETE SET NULL,
  joined_at       timestamptz NULL,
  removed_at      timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX organization_members_org_user_key
  ON organization_members (organization_id, user_id);
CREATE INDEX organization_members_user_id_idx ON organization_members (user_id);
CREATE INDEX organization_members_invited_by_idx
  ON organization_members (invited_by) WHERE invited_by IS NOT NULL;

ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON organization_members
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

-- ---------------------------------------------------------------------------------------
-- team_members
-- ---------------------------------------------------------------------------------------
-- Carries organization_id even though it is derivable through team_id. The convention is
-- that every tenant-scoped table carries the tenant column (05 §1) so the RLS predicate is
-- a column comparison rather than a join — the whole reason the three-level hierarchy stays
-- cheap at query time.
CREATE TABLE team_members (
  id                      uuid        PRIMARY KEY,
  organization_id         uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  team_id                 uuid        NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  organization_member_id  uuid        NOT NULL
                                      REFERENCES organization_members (id) ON DELETE CASCADE,
  role                    text        NOT NULL DEFAULT 'team_member'
                                      CHECK (role IN ('team_lead', 'team_member')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX team_members_team_member_key
  ON team_members (team_id, organization_member_id);
CREATE INDEX team_members_organization_id_idx ON team_members (organization_id);
CREATE INDEX team_members_organization_member_id_idx ON team_members (organization_member_id);

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON team_members
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

-- ---------------------------------------------------------------------------------------
-- team_workspace_access — specialist pods
-- ---------------------------------------------------------------------------------------
-- The mechanism that makes agency access maintainable: granting a second team access to a
-- client is one auditable row, not a grant per person per client (06 §3).
CREATE TABLE team_workspace_access (
  id              uuid        PRIMARY KEY,
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  team_id         uuid        NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  workspace_id    uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  access_level    text        NOT NULL DEFAULT 'contributor'
                              CHECK (access_level IN ('viewer', 'contributor', 'editor',
                                                      'approver', 'workspace_admin')),
  -- Time-boxed client access: an expired grant stops contributing to the accessible set
  -- without anyone remembering to remove it.
  expires_at      timestamptz NULL,
  granted_by      uuid        NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX team_workspace_access_team_workspace_key
  ON team_workspace_access (team_id, workspace_id);
CREATE INDEX team_workspace_access_organization_id_idx
  ON team_workspace_access (organization_id);
CREATE INDEX team_workspace_access_workspace_id_idx ON team_workspace_access (workspace_id);
CREATE INDEX team_workspace_access_granted_by_idx
  ON team_workspace_access (granted_by) WHERE granted_by IS NOT NULL;

ALTER TABLE team_workspace_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_workspace_access FORCE ROW LEVEL SECURITY;

-- Plain tenant predicate, NOT restricted to the accessible-workspace set. This table is an
-- INPUT to computing that set; filtering it by the set it produces would be circular, and
-- would make the resolver unable to see the grants it exists to read.
CREATE POLICY tenant_isolation ON team_workspace_access
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON organizations, teams, workspaces,
  organization_members, team_members, team_workspace_access TO growth_os_app;
