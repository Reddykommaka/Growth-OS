/**
 * Shared fixture for the Phase 1 agency scenario.
 *
 * Builds a real agency in a real cluster: two pods, four client workspaces, staff on each
 * pod, and one client-side reviewer. Extracted so the scenario assertions can be split
 * across files without either copy of the setup drifting from the other — a fixture
 * duplicated between two suites is a fixture that eventually tests two different systems.
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@growth-os/db';
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from '@growth-os/testing';
import { Client, type PoolClient } from 'pg';
import { resolveActorContext } from '../actor-resolver.js';
import {
  addMember,
  addTeamMember,
  assignRole,
  createTeam,
  createWorkspace,
  provisionOrganization,
} from '../provisioning.js';

export let db: TestDatabase;
export let admin: Client;

/** The cast: an agency with two pods, four clients, staff and one client-side reviewer. */
export const users = {
  principal: randomUUID(),
  podALead: randomUUID(),
  podAStaff: randomUUID(),
  podBLead: randomUUID(),
  clientReviewer: randomUUID(),
  outsider: randomUUID(),
};

export let orgId: string;
export function podAId(): string {
  return podA;
}
export function podBId(): string {
  return podB;
}
let podA: string;
let podB: string;
export const clients: Record<string, string> = {};
export const members: Record<string, string> = {};

async function createUser(id: string, email: string): Promise<void> {
  await admin.query(`INSERT INTO users (id, email, status) VALUES ($1, $2, 'active')`, [id, email]);
}

/** Creates the two pods and the four client workspaces they serve. */
async function buildPodsAndClients(c: PoolClient): Promise<void> {
  podA = await createTeam(c, orgId, 'pod-a', 'Pod A');
  podB = await createTeam(c, orgId, 'pod-b', 'Pod B');

  clients['acme'] = await createWorkspace(c, {
    organizationId: orgId,
    teamId: podA,
    slug: 'acme',
    name: 'Acme',
  });
  clients['borealis'] = await createWorkspace(c, {
    organizationId: orgId,
    teamId: podA,
    slug: 'borealis',
    name: 'Borealis',
  });
  clients['cygnus'] = await createWorkspace(c, {
    organizationId: orgId,
    teamId: podB,
    slug: 'cygnus',
    name: 'Cygnus',
  });
  clients['delta'] = await createWorkspace(c, {
    organizationId: orgId,
    teamId: podB,
    slug: 'delta',
    name: 'Delta',
  });
}

/** Staffs the pods and gives the client their reviewer. */
async function buildStaff(c: PoolClient): Promise<void> {
  members['podALead'] = await addMember(c, { organizationId: orgId, userId: users.podALead });
  members['podAStaff'] = await addMember(c, { organizationId: orgId, userId: users.podAStaff });
  members['podBLead'] = await addMember(c, { organizationId: orgId, userId: users.podBLead });
  members['clientReviewer'] = await addMember(c, {
    organizationId: orgId,
    userId: users.clientReviewer,
    memberType: 'client',
  });

  await addTeamMember(c, orgId, podA, members['podALead'] as string, 'team_lead');
  await addTeamMember(c, orgId, podA, members['podAStaff'] as string, 'team_member');
  await addTeamMember(c, orgId, podB, members['podBLead'] as string, 'team_lead');

  await assignRole(c, {
    organizationId: orgId,
    memberId: members['podALead'] as string,
    roleSlug: 'team_lead',
    teamId: podA,
  });
  await assignRole(c, {
    organizationId: orgId,
    memberId: members['podAStaff'] as string,
    roleSlug: 'team_member',
    teamId: podA,
  });
  await assignRole(c, {
    organizationId: orgId,
    memberId: members['podBLead'] as string,
    roleSlug: 'team_lead',
    teamId: podB,
  });
  // The client's own reviewer: one workspace, nothing else.
  await assignRole(c, {
    organizationId: orgId,
    memberId: members['clientReviewer'] as string,
    roleSlug: 'client_guest',
    workspaceId: clients['acme'] as string,
  });
}

/**
 * A representative WORKSPACE-SCOPED (level 3) table, with one row per client.
 *
 * No product table carries workspace_id until Phase 3, so the containment claim in
 * db/policies/workspaces.sql — that a guest cannot read another client's WORK even though
 * the workspace row itself is organization-scoped — would otherwise go unproven until then.
 */
async function buildContentProbe(): Promise<void> {
  await admin.query(`
    CREATE TABLE content_probe (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      workspace_id    uuid NOT NULL,
      title           text NOT NULL
    );
    CREATE INDEX content_probe_ws_idx ON content_probe (organization_id, workspace_id);
    ALTER TABLE content_probe ENABLE ROW LEVEL SECURITY;
    ALTER TABLE content_probe FORCE  ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON content_probe
      USING      (organization_id = app_current_organization_id()
                  AND workspace_id = ANY (app_current_workspace_ids()))
      WITH CHECK (organization_id = app_current_organization_id()
                  AND workspace_id = ANY (app_current_workspace_ids()));
    GRANT SELECT, INSERT, UPDATE, DELETE ON content_probe TO growth_os_app;
  `);
  for (const [name, workspaceId] of Object.entries(clients)) {
    await admin.query(
      'INSERT INTO content_probe (organization_id, workspace_id, title) VALUES ($1, $2, $3)',
      [orgId, workspaceId, `${name}-post`],
    );
  }
}

/** Runs a body inside the principal's tenant context. */
export async function asPrincipal<T>(body: (c: PoolClient) => Promise<T>): Promise<T> {
  const ctx = await resolveActorContext(db.pool, {
    userId: users.principal,
    organizationId: orgId,
    mfaSatisfied: true,
  });
  if (ctx === undefined) throw new Error('principal context did not resolve');
  return await withTenant(
    db.pool,
    {
      organizationId: orgId,
      userId: users.principal,
      workspaceIds: ctx.accessibleWorkspaceIds,
    },
    async (tx) => await body(tx.client),
  );
}

export async function setupAgency(): Promise<void> {
  db = await acquireTestDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();

  for (const [name, id] of Object.entries(users)) {
    await createUser(id, `${name}@agency.test`);
  }

  const provisioned = await provisionOrganization(db.pool, {
    name: 'Northwind Digital',
    slug: 'northwind',
    kind: 'agency',
    ownerUserId: users.principal,
  });
  orgId = provisioned.organizationId;
  members['principal'] = provisioned.ownerMemberId;

  await asPrincipal(buildPodsAndClients);
  await asPrincipal(buildStaff);
  await buildContentProbe();
}

export async function teardownAgency(): Promise<void> {
  await admin.end();
  await db.close();
  await stopSharedCluster();
}

/**
 * The workspaces an actor can actually reach — the product's own listing path.
 *
 * `workspaces` is organization-scoped (05 §3 level 2), so RLS alone would return every
 * workspace in the tenant. Intra-organization scoping is the accessible set's job, applied
 * here exactly as a product query would apply it. Cross-ORGANIZATION isolation is RLS's job
 * and is asserted separately below, so both layers are covered rather than conflated.
 */
export async function visibleWorkspaces(userId: string): Promise<string[]> {
  const ctx = await resolveActorContext(db.pool, {
    userId,
    organizationId: orgId,
    mfaSatisfied: true,
  });
  if (ctx === undefined) return [];
  return await withTenant(
    db.pool,
    { organizationId: orgId, userId, workspaceIds: ctx.accessibleWorkspaceIds },
    async (tx) => {
      const r = await tx.query<{ slug: string }>(
        'SELECT slug FROM workspaces WHERE id = ANY($1::uuid[]) ORDER BY slug',
        [ctx.accessibleWorkspaceIds],
      );
      return r.rows.map((row) => row.slug);
    },
  );
}

/** Reads a workspace-SCOPED (level 3) table, where RLS itself applies the set. */
export async function visibleContent(userId: string): Promise<string[]> {
  const ctx = await resolveActorContext(db.pool, {
    userId,
    organizationId: orgId,
    mfaSatisfied: true,
  });
  if (ctx === undefined) return [];
  return await withTenant(
    db.pool,
    { organizationId: orgId, userId, workspaceIds: ctx.accessibleWorkspaceIds },
    async (tx) => {
      const r = await tx.query<{ title: string }>('SELECT title FROM content_probe ORDER BY title');
      return r.rows.map((row) => row.title);
    },
  );
}
