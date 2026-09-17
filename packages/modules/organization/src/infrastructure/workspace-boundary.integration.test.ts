/**
 * REGRESSION SUITE — the workspace authorization boundary.
 *
 * Two defects found in review of work items 1.1-1.4, both inside a single organization:
 *
 *   A. `workspaces` was organization-scoped only, so ANY session could enumerate every
 *      workspace row in its own tenant with raw SQL, regardless of its accessible set.
 *
 *   B. `hasOrganizationScopedRole` was true for ANY organization-scoped assignment,
 *      including `member` — a role whose entire permission set is
 *      `organization.organization:read`. A plain member therefore resolved to an accessible
 *      set containing EVERY workspace in the organization.
 *
 * B is the more serious of the two: it is not merely a read of a name, it is the value that
 * becomes `app.workspace_ids`, which is the predicate every workspace-scoped table in the
 * system is filtered by. A plain member would have been handed the whole tenant's content.
 *
 * Neither is cross-tenant. Both are authorization boundary defects, and this suite is the
 * proof they stay fixed.
 */

import { randomUUID } from 'node:crypto';
import { type ActorContext, decide } from '@growth-os/authz';
import { withTenant } from '@growth-os/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  clients,
  db,
  orgId,
  setupAgency,
  teardownAgency,
  users,
} from './__testing__/agency-fixture.js';
import { resolveActorContext } from './actor-resolver.js';
import { addMember, assignRole } from './provisioning.js';

/** A user who is a legitimate member of the organization with no workspace access at all. */
const plainMemberUser = randomUUID();

beforeAll(async () => {
  await setupAgency();
  await admin.query(`INSERT INTO users (id, email, status) VALUES ($1, $2, 'active')`, [
    plainMemberUser,
    'plain@agency.test',
  ]);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.organization_id', orgId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_scope', 'all']);
    const memberId = await addMember(client, { organizationId: orgId, userId: plainMemberUser });
    // An organization-scoped role that grants NO workspace-scoped permission.
    await assignRole(client, { organizationId: orgId, memberId, roleSlug: 'member' });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}, 180_000);

afterAll(teardownAgency);

async function contextFor(userId: string) {
  const ctx = await resolveActorContext(db.pool, {
    userId,
    organizationId: orgId,
    mfaSatisfied: true,
  });
  if (ctx === undefined) throw new Error(`no context for ${userId}`);
  return ctx;
}

/** Reads workspace rows the way a compromised or buggy call site would: raw, unfiltered. */
async function rawWorkspaceRead(
  ctx: Awaited<ReturnType<typeof contextFor>>,
  userId: string,
): Promise<string[]> {
  return await withTenant(
    db.pool,
    {
      organizationId: orgId,
      userId,
      workspaceIds: ctx.accessibleWorkspaceIds,
      workspaceScope: ctx.workspaceScope,
    },
    async (tx) => {
      const r = await tx.query<{ slug: string }>('SELECT slug FROM workspaces ORDER BY slug');
      return r.rows.map((row) => row.slug);
    },
  );
}

describe('DEFECT B — an organization role without workspace permissions grants no workspaces', () => {
  it('a plain member resolves to an EMPTY accessible set', async () => {
    const ctx = await contextFor(plainMemberUser);
    expect(ctx.accessibleWorkspaceIds).toEqual([]);
  });

  it('a plain member is denied every workspace in the organization', async () => {
    const ctx = await contextFor(plainMemberUser);
    for (const [name, workspaceId] of Object.entries(clients)) {
      const decision = decide(ctx, 'social.post:read', {
        type: 'post',
        id: 'p',
        workspaceId: workspaceId as string,
      });
      expect(decision.allowed, name).toBe(false);
    }
  });

  it('an organization role that DOES grant workspace permissions still spans the tenant', async () => {
    const ctx = await contextFor(users.principal);
    expect(ctx.accessibleWorkspaceIds.length).toBeGreaterThan(1);
  });
});

describe('DEFECT A — a session cannot enumerate workspaces outside its accessible set', () => {
  it('a plain member sees NO workspace rows, even with raw SQL', async () => {
    const ctx = await contextFor(plainMemberUser);
    expect(await rawWorkspaceRead(ctx, plainMemberUser)).toEqual([]);
  });

  it("a pod lead sees only their own pod's clients, even with raw SQL", async () => {
    const ctx = await contextFor(users.podALead);
    const rows = await rawWorkspaceRead(ctx, users.podALead);
    expect(rows).not.toContain('cygnus');
    expect(rows).not.toContain('delta');
    expect(rows).toContain('acme');
  });

  it('the client guest sees only their own workspace, even with raw SQL', async () => {
    const ctx = await contextFor(users.clientReviewer);
    expect(await rawWorkspaceRead(ctx, users.clientReviewer)).toEqual(['acme']);
  });

  it('an organization-wide actor still sees every workspace — that IS their access', async () => {
    const ctx = await contextFor(users.principal);
    const rows = await rawWorkspaceRead(ctx, users.principal);
    expect(rows).toContain('acme');
    expect(rows).toContain('delta');
  });
});

describe('authorized workspace membership still succeeds', () => {
  it('a pod lead may act in a client their pod serves', async () => {
    const ctx = await contextFor(users.podALead);
    expect(
      decide(ctx, 'social.post:publish', {
        type: 'post',
        id: 'p',
        workspaceId: clients['acme'] as string,
      }).allowed,
    ).toBe(true);
  });

  it('a client guest may approve in their own workspace', async () => {
    const ctx = await contextFor(users.clientReviewer);
    expect(
      decide(ctx, 'social.post:approve', {
        type: 'post',
        id: 'p',
        workspaceId: clients['acme'] as string,
      }).allowed,
    ).toBe(true);
  });
});

describe('cross-tenant access remains denied', () => {
  it("a rival organization's workspace is invisible even with its id smuggled into the set", async () => {
    const rivalOrg = randomUUID();
    const rivalWorkspace = randomUUID();
    await admin.query(
      `INSERT INTO organizations (id, slug, name, kind) VALUES ($1, 'rival-b', 'Rival', 'agency')`,
      [rivalOrg],
    );
    await admin.query(
      `INSERT INTO workspaces (id, organization_id, slug, name)
         VALUES ($1, $2, 'rival-secret', 'Secret')`,
      [rivalWorkspace, rivalOrg],
    );

    const rows = await withTenant(
      db.pool,
      {
        organizationId: orgId,
        userId: users.principal,
        workspaceIds: [rivalWorkspace],
        // Even claiming organization-wide scope must not cross the tenant boundary.
        workspaceScope: 'all',
      },
      async (tx) =>
        (await tx.query('SELECT slug FROM workspaces WHERE id = $1', [rivalWorkspace])).rows,
    );
    expect(rows).toEqual([]);
  });
});

describe('impersonation cannot bypass workspace authorization', () => {
  it('an impersonated session is still bound by the accessible set', async () => {
    const ctx = await resolveActorContext(db.pool, {
      userId: users.clientReviewer,
      organizationId: orgId,
      mfaSatisfied: true,
      impersonated: true,
    });
    if (ctx === undefined) throw new Error('no context');
    expect(ctx.impersonated).toBe(true);
    expect(ctx.accessibleWorkspaceIds).toEqual([clients['acme']]);

    const decision = decide(ctx, 'social.post:read', {
      type: 'post',
      id: 'p',
      workspaceId: clients['cygnus'] as string,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('workspace_not_accessible');
  });

  it('an impersonated session cannot widen its scope at the database either', async () => {
    const ctx = await resolveActorContext(db.pool, {
      userId: users.clientReviewer,
      organizationId: orgId,
      mfaSatisfied: true,
      impersonated: true,
    });
    if (ctx === undefined) throw new Error('no context');
    expect(await rawWorkspaceRead(ctx, users.clientReviewer)).toEqual(['acme']);
  });
});

describe('API key authorization cannot bypass workspace authorization', () => {
  it('a key narrowed to one workspace is denied every other one', async () => {
    const base = await contextFor(users.principal);
    const key: ActorContext = {
      ...base,
      kind: 'api_key' as const,
      apiKeyId: 'k-1',
      apiKeyScopes: ['social'],
      apiKeyWorkspaceId: clients['acme'] as string,
    };
    // A machine actor has no user and no membership row. Under exactOptionalPropertyTypes
    // that is expressed by ABSENCE, not by an explicit undefined — which is also how a real
    // resolved key actor is built.
    delete (key as { userId?: string }).userId;
    delete (key as { organizationMemberId?: string }).organizationMemberId;
    expect(
      decide(key, 'social.post:read', {
        type: 'post',
        id: 'p',
        workspaceId: clients['acme'] as string,
      }).allowed,
    ).toBe(true);
    const denied = decide(key, 'social.post:read', {
      type: 'post',
      id: 'p',
      workspaceId: clients['cygnus'] as string,
    });
    expect(denied.allowed).toBe(false);
  });

  it('a key cannot reach a workspace outside the set it was resolved with', async () => {
    const base = await contextFor(users.podALead);
    const key: ActorContext = {
      ...base,
      kind: 'api_key' as const,
      apiKeyId: 'k-2',
      apiKeyScopes: ['social'],
    };
    const denied = decide(key, 'social.post:read', {
      type: 'post',
      id: 'p',
      workspaceId: clients['delta'] as string,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.allowed === false && denied.reason).toBe('workspace_not_accessible');
  });
});
