/**
 * The agency fixture the invitation and API-key suites share.
 *
 * One shape, built once per suite: two organizations that must never see each other, and
 * inside the first, a team owning two workspaces plus members at three different levels of
 * reach. Almost every isolation assertion in those suites is "X cannot reach Y" for some
 * pair drawn from this picture, so the picture belongs in one place — a second, subtly
 * different copy is how two suites come to disagree about what they are proving.
 *
 * Nothing here is a mock. Organizations are provisioned through the production path, roles
 * are assigned through the production path, and every actor is resolved by
 * `resolveActorContext`, so the permissions under test are the real ones.
 */

import { randomUUID } from 'node:crypto';
import { withTenant } from '@growth-os/db';
import { acquireTestDatabase, type TestDatabase } from '@growth-os/testing';
import { Client, type PoolClient } from 'pg';
import { resolveActorContext } from '../infrastructure/actor-resolver.js';
import {
  addMember,
  assignRole,
  createTeam,
  createWorkspace,
  provisionOrganization,
} from '../infrastructure/provisioning.js';

export interface AgencyFixture {
  readonly db: TestDatabase;
  /** Superuser connection, for seeding users and for asserting on rows RLS would hide. */
  readonly admin: Client;
  readonly agencyOrg: string;
  readonly rivalOrg: string;
  /** Organization-wide reach, every permission. */
  readonly ownerUser: string;
  /** Organization-wide reach, everything except deleting the organization. */
  readonly adminUser: string;
  /** One workspace only, and no privileged permissions. */
  readonly editorUser: string;
  readonly rivalOwnerUser: string;
  readonly acme: string;
  readonly borealis: string;
  readonly rivalWorkspace: string;

  createUser(email: string): Promise<string>;
  /** A real resolved actor context — the production authorization path. */
  actorFor(userId: string, organizationId?: string): Promise<ActorFor>;
  /** Runs a body inside a tenant transaction carrying that actor's resolved context. */
  asActor<T>(
    userId: string,
    organizationId: string,
    body: (client: PoolClient) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

type ActorFor = Awaited<ReturnType<typeof resolveActorContext>> & object;

/**
 * One team owning two workspaces, plus members at two levels of reach.
 *
 * Split out of `buildAgencyFixture` because the fixture's job is composition and this is
 * the part that actually shapes what the isolation assertions mean.
 */
async function seedAgency(
  c: PoolClient,
  organizationId: string,
  users: { adminUser: string; editorUser: string },
): Promise<{ acme: string; borealis: string }> {
  const pod = await createTeam(c, organizationId, 'pod-a', 'Pod A');
  const acme = await createWorkspace(c, {
    organizationId,
    teamId: pod,
    slug: 'acme',
    name: 'Acme',
  });
  const borealis = await createWorkspace(c, {
    organizationId,
    teamId: pod,
    slug: 'borealis',
    name: 'Borealis',
  });

  // Organization-scoped: everything except deleting the organization.
  const adminMember = await addMember(c, { organizationId, userId: users.adminUser });
  await assignRole(c, { organizationId, memberId: adminMember, roleSlug: 'admin' });

  // Workspace-scoped, one workspace, and no privileged permissions at all.
  const editorMember = await addMember(c, { organizationId, userId: users.editorUser });
  await assignRole(c, {
    organizationId,
    memberId: editorMember,
    roleSlug: 'editor',
    workspaceId: acme,
  });

  return { acme, borealis };
}

export async function buildAgencyFixture(): Promise<AgencyFixture> {
  const db = await acquireTestDatabase();
  const admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();

  const createUser = async (email: string): Promise<string> => {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email, status) VALUES ($1, $2, 'active')`, [
      id,
      email,
    ]);
    return id;
  };

  const actorFor = async (userId: string, organizationId: string): Promise<ActorFor> => {
    const ctx = await resolveActorContext(db.pool, { userId, organizationId, mfaSatisfied: true });
    if (ctx === undefined) throw new Error(`no context for ${userId} in ${organizationId}`);
    return ctx;
  };

  const asActor = async <T>(
    userId: string,
    organizationId: string,
    body: (client: PoolClient) => Promise<T>,
  ): Promise<T> => {
    const ctx = await actorFor(userId, organizationId);
    return await withTenant(
      db.pool,
      {
        organizationId,
        userId,
        workspaceIds: ctx.accessibleWorkspaceIds,
        workspaceScope: ctx.workspaceScope,
      },
      async (tx) => await body(tx.client),
    );
  };

  const ownerUser = await createUser('owner@agency.test');
  const adminUser = await createUser('admin@agency.test');
  const editorUser = await createUser('editor@agency.test');
  const rivalOwnerUser = await createUser('owner@rival.test');

  const agency = await provisionOrganization(db.pool, {
    name: 'Northwind',
    slug: 'northwind',
    kind: 'agency',
    ownerUserId: ownerUser,
  });
  const rival = await provisionOrganization(db.pool, {
    name: 'Rival',
    slug: 'rival',
    kind: 'agency',
    ownerUserId: rivalOwnerUser,
  });

  const { acme, borealis } = await asActor(
    ownerUser,
    agency.organizationId,
    async (c) => await seedAgency(c, agency.organizationId, { adminUser, editorUser }),
  );
  const rivalWorkspace = await asActor(rivalOwnerUser, rival.organizationId, async (c) => {
    const pod = await createTeam(c, rival.organizationId, 'pod-r', 'Pod R');
    return await createWorkspace(c, {
      organizationId: rival.organizationId,
      teamId: pod,
      slug: 'rival-ws',
      name: 'Rival WS',
    });
  });

  return {
    db,
    admin,
    agencyOrg: agency.organizationId,
    rivalOrg: rival.organizationId,
    ownerUser,
    adminUser,
    editorUser,
    rivalOwnerUser,
    acme,
    borealis,
    rivalWorkspace,
    createUser,
    actorFor: async (userId, organizationId = agency.organizationId) =>
      await actorFor(userId, organizationId),
    asActor,
    close: async () => {
      await admin.end();
      await db.close();
    },
  };
}

export interface Recorder {
  readonly events: { action: string; metadata?: unknown }[];
  readonly clock: { now(): Date };
  readonly audit: { record(e: { action: string; metadata?: unknown }): Promise<void> };
  advanceTo(at: Date): void;
  advanceBy(ms: number): void;
  reset(): void;
}

/** A recording audit sink plus a clock the suite can move. Shared for the same reason. */
export function createRecorder(start = new Date('2026-09-15T12:00:00.000Z')): Recorder {
  const events: { action: string; metadata?: unknown }[] = [];
  let now = start;
  return {
    events,
    clock: { now: () => now },
    audit: {
      record: async (e: { action: string; metadata?: unknown }) => {
        events.push({ action: e.action, metadata: e.metadata });
      },
    },
    advanceTo: (at: Date) => {
      now = at;
    },
    advanceBy: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    reset: () => {
      events.length = 0;
      now = start;
    },
  };
}
