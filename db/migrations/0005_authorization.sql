-- 0005 — Roles, assignments, grants, invitations and API keys.
--
-- Phase 1, per 06-identity-and-access.md §3 and 05-data-architecture.md §2.
--
-- Roles are DATA, not code. That is what makes custom roles cheap for agencies and
-- enterprises, and it is what lets the authorization matrix test enumerate every permission
-- automatically instead of relying on someone to remember to test a new one.

-- ---------------------------------------------------------------------------------------
-- roles
-- ---------------------------------------------------------------------------------------
-- organization_id is NULLABLE here, and it is the ONLY tenant-scoped table where that is
-- true (05 §2). A NULL row is a system role shared by every tenant; a non-NULL row is one
-- organization's custom role. The alternative — copying nine system roles into every new
-- organization — would mean a permission added to a system role never reaches any existing
-- tenant.
CREATE TABLE roles (
  id              uuid        PRIMARY KEY,
  organization_id uuid        NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  slug            text        NOT NULL,
  name            text        NOT NULL,
  description     text        NULL,
  scope           text        NOT NULL
                              CHECK (scope IN ('organization', 'team', 'workspace')),
  is_system       boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- A system role has no organization; a custom role must have one. Stating it as a
  -- constraint means the two kinds cannot be confused by a bad insert.
  CONSTRAINT roles_system_has_no_org CHECK (
    (is_system AND organization_id IS NULL) OR (NOT is_system AND organization_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX roles_system_slug_key
  ON roles (slug, scope) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX roles_custom_slug_key
  ON roles (organization_id, slug, scope) WHERE organization_id IS NOT NULL;
CREATE INDEX roles_organization_id_idx
  ON roles (organization_id) WHERE organization_id IS NOT NULL;

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;

-- DELIBERATELY ASYMMETRIC — and this is exactly the shape 06 §4 warns about, written the
-- safe way. USING is broader than the write rule because system roles must be readable by
-- every tenant. With WITH CHECK omitted, PostgreSQL would reuse that broad USING as the
-- write predicate and a tenant could INSERT a row with organization_id NULL — minting
-- itself a SYSTEM ROLE visible to every other tenant. The explicit narrow WITH CHECK is
-- what closes that, and a dedicated probe asserts it (the generic probe cannot: only this
-- policy's author knows that NULL is the value satisfying the broad predicate).
CREATE POLICY tenant_isolation ON roles
  USING      (organization_id IS NULL OR organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

-- ---------------------------------------------------------------------------------------
-- role_permissions
-- ---------------------------------------------------------------------------------------
CREATE TABLE role_permissions (
  id              uuid        PRIMARY KEY,
  organization_id uuid        NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  role_id         uuid        NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  -- A permission literal from the catalogue in packages/platform/authz. Stored as text
  -- rather than a lookup FK so the catalogue can live in code, where the exhaustive
  -- TypeScript union makes a typo a compile error.
  permission      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX role_permissions_role_permission_key
  ON role_permissions (role_id, permission);
CREATE INDEX role_permissions_organization_id_idx
  ON role_permissions (organization_id) WHERE organization_id IS NOT NULL;

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

-- Same asymmetry and same reason as roles: the permissions OF a system role must be
-- readable by every tenant, but only this tenant's own rows may be written.
CREATE POLICY tenant_isolation ON role_permissions
  USING      (organization_id IS NULL OR organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

-- ---------------------------------------------------------------------------------------
-- role_assignments — the three scopes
-- ---------------------------------------------------------------------------------------
CREATE TABLE role_assignments (
  id                      uuid        PRIMARY KEY,
  organization_id         uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  organization_member_id  uuid        NOT NULL
                                      REFERENCES organization_members (id) ON DELETE CASCADE,
  role_id                 uuid        NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  -- Scope is expressed by WHICH of these is set, not by a separate discriminator column
  -- that could disagree with them.
  team_id                 uuid        NULL REFERENCES teams (id) ON DELETE CASCADE,
  workspace_id            uuid        NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  granted_by              uuid        NULL REFERENCES users (id) ON DELETE SET NULL,
  expires_at              timestamptz NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- Both set would be a scope that does not exist in the model (06 §3).
  CONSTRAINT role_assignments_single_scope CHECK (
    NOT (team_id IS NOT NULL AND workspace_id IS NOT NULL)
  )
);

-- Partial unique indexes per scope: the same member may hold the same role org-wide, on a
-- team and on a workspace, but not twice at the same scope. A plain UNIQUE over nullable
-- columns would not enforce this, because NULLs do not compare equal.
CREATE UNIQUE INDEX role_assignments_org_scope_key
  ON role_assignments (organization_member_id, role_id)
  WHERE team_id IS NULL AND workspace_id IS NULL;
CREATE UNIQUE INDEX role_assignments_team_scope_key
  ON role_assignments (organization_member_id, role_id, team_id)
  WHERE team_id IS NOT NULL;
CREATE UNIQUE INDEX role_assignments_workspace_scope_key
  ON role_assignments (organization_member_id, role_id, workspace_id)
  WHERE workspace_id IS NOT NULL;

CREATE INDEX role_assignments_organization_id_idx ON role_assignments (organization_id);
CREATE INDEX role_assignments_role_id_idx ON role_assignments (role_id);
CREATE INDEX role_assignments_team_id_idx
  ON role_assignments (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX role_assignments_workspace_id_idx
  ON role_assignments (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX role_assignments_granted_by_idx
  ON role_assignments (granted_by) WHERE granted_by IS NOT NULL;
-- The resolver's query: every assignment for one member, in one organization.
CREATE INDEX role_assignments_member_idx
  ON role_assignments (organization_id, organization_member_id);

ALTER TABLE role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignments FORCE ROW LEVEL SECURITY;

-- Plain tenant predicate, NOT filtered by the accessible-workspace set: this table is an
-- input to computing that set (see team_workspace_access in 0004 for the same reasoning).
CREATE POLICY tenant_isolation ON role_assignments
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

-- ---------------------------------------------------------------------------------------
-- resource_grants — per-resource sharing
-- ---------------------------------------------------------------------------------------
-- The case pure RBAC handles badly: sharing one campaign or one report with someone who
-- otherwise has no access to it.
CREATE TABLE resource_grants (
  id              uuid        PRIMARY KEY,
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  subject_type    text        NOT NULL CHECK (subject_type IN ('member', 'team')),
  -- No FK: the subject is polymorphic across organization_members and teams. Integrity is
  -- asserted by the application and a nightly consistency check (05 §4).
  subject_id      uuid        NOT NULL,
  resource_type   text        NOT NULL,
  resource_id     uuid        NOT NULL,
  permission      text        NOT NULL,
  granted_by      uuid        NULL REFERENCES users (id) ON DELETE SET NULL,
  expires_at      timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX resource_grants_unique_key
  ON resource_grants (subject_type, subject_id, resource_type, resource_id, permission);
CREATE INDEX resource_grants_organization_id_idx ON resource_grants (organization_id);
-- The evaluation-order lookup: does this actor hold a grant on this exact resource.
CREATE INDEX resource_grants_resource_idx
  ON resource_grants (organization_id, resource_type, resource_id);
CREATE INDEX resource_grants_granted_by_idx
  ON resource_grants (granted_by) WHERE granted_by IS NOT NULL;

ALTER TABLE resource_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON resource_grants
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

-- ---------------------------------------------------------------------------------------
-- invitations
-- ---------------------------------------------------------------------------------------
CREATE TABLE invitations (
  id              uuid        PRIMARY KEY,
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  email           citext      NOT NULL,
  role_id         uuid        NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  -- The scope the invited role will be assigned at, carried so accepting an invitation is
  -- a single atomic step rather than a create-then-grant that can half-fail.
  team_id         uuid        NULL REFERENCES teams (id) ON DELETE CASCADE,
  workspace_id    uuid        NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  member_type     text        NOT NULL DEFAULT 'staff'
                              CHECK (member_type IN ('staff', 'client')),
  -- Hash only, like every other token in this system.
  token_hash      bytea       NOT NULL,
  invited_by      uuid        NULL REFERENCES users (id) ON DELETE SET NULL,
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz NULL,
  revoked_at      timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_single_scope CHECK (
    NOT (team_id IS NOT NULL AND workspace_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX invitations_token_hash_key ON invitations (token_hash);
-- One live invitation per address per organization; a revoked or accepted one must not
-- block re-inviting.
CREATE UNIQUE INDEX invitations_pending_key
  ON invitations (organization_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invitations_organization_id_idx ON invitations (organization_id);
CREATE INDEX invitations_role_id_idx ON invitations (role_id);
CREATE INDEX invitations_team_id_idx ON invitations (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX invitations_workspace_id_idx
  ON invitations (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX invitations_invited_by_idx
  ON invitations (invited_by) WHERE invited_by IS NOT NULL;

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invitations
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

-- ---------------------------------------------------------------------------------------
-- api_keys
-- ---------------------------------------------------------------------------------------
CREATE TABLE api_keys (
  id              uuid        PRIMARY KEY,
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  name            text        NOT NULL,
  -- The public half of gos_live_<prefix>_<secret>. Stored in clear so a key can be
  -- identified in a list and by secret scanning; it is not a credential on its own.
  prefix          text        NOT NULL,
  -- Argon2 of the secret half. The full key is displayed once and is unrecoverable
  -- thereafter, which makes rotation the only remedy for a leak — by design (06 §5).
  key_hash        text        NOT NULL,
  scopes          text[]      NOT NULL DEFAULT '{}',
  -- A key may be narrowed to one workspace, so an integration built for one client cannot
  -- read another.
  workspace_id    uuid        NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  created_by      uuid        NULL REFERENCES users (id) ON DELETE SET NULL,
  last_used_at    timestamptz NULL,
  expires_at      timestamptz NULL,
  revoked_at      timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX api_keys_prefix_key ON api_keys (prefix);
CREATE INDEX api_keys_organization_id_idx ON api_keys (organization_id);
CREATE INDEX api_keys_workspace_id_idx
  ON api_keys (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX api_keys_created_by_idx ON api_keys (created_by) WHERE created_by IS NOT NULL;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON api_keys
  USING      (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON roles, role_permissions, role_assignments,
  resource_grants, invitations, api_keys TO growth_os_app;
