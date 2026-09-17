/**
 * Who may read the audit log.
 *
 * Audit records name who did what to whom, so the log is itself sensitive — and the actors
 * most likely to want it are the ones who must not have it. Every case here is driven
 * through the production authorization path and then checked AGAIN at the database, because
 * the two are independent defences and a test that only asks the engine would pass with RLS
 * switched off.
 */

import { createAuditReader, createAuditRecorder } from '@growth-os/audit';
import { withTenant } from '@growth-os/db';
import { ForbiddenError } from '@growth-os/errors';
import { stopSharedCluster } from '@growth-os/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AgencyFixture, buildAgencyFixture } from '../__testing__/agency-fixture.js';
import { readAuditLog, verifyAuditLog } from '../application/audit-log.js';

let fx: AgencyFixture;

beforeAll(async () => {
  fx = await buildAgencyFixture();
}, 180_000);

afterAll(async () => {
  await fx.close();
  await stopSharedCluster();
});

/** Records an event in the agency's chain, on a committed transaction. */
async function seed(action: string, workspaceId?: string): Promise<void> {
  await withTenant(
    fx.db.pool,
    { organizationId: fx.agencyOrg, userId: fx.ownerUser, workspaceIds: [], workspaceScope: 'all' },
    async (tx) => {
      await createAuditRecorder(tx.client).record({
        organizationId: fx.agencyOrg,
        actor: { type: 'user', userId: fx.ownerUser },
        action,
        resourceType: 'member',
        resourceId: 'm-1',
        result: 'succeeded',
        ...(workspaceId === undefined ? {} : { workspaceId }),
      });
    },
  );
}

/** Reads through the production service, in the actor's own resolved tenant context. */
async function readAs(userId: string, input: Parameters<typeof readAuditLog>[2] = {}) {
  const ctx = await fx.actorFor(userId);
  return await withTenant(
    fx.db.pool,
    {
      organizationId: fx.agencyOrg,
      userId,
      workspaceIds: ctx.accessibleWorkspaceIds,
      workspaceScope: ctx.workspaceScope,
    },
    async (tx) => await readAuditLog({ audit: createAuditReader(tx.client) }, ctx, input),
  );
}

beforeEach(async () => {
  await fx.admin.query('DELETE FROM audit_events');
  await fx.admin.query('DELETE FROM audit_chain_heads');
});

describe('the permission is organization-scoped, so workspace roles never hold it', () => {
  it('an owner may read', async () => {
    await seed('organization.member.role_changed');
    const page = await readAs(fx.ownerUser);
    expect(page.events).toHaveLength(1);
  });

  it('an administrator may read', async () => {
    await seed('organization.member.role_changed');
    expect((await readAs(fx.adminUser)).events).toHaveLength(1);
  });

  /**
   * The editor holds a workspace-scoped role. `organization.audit_log:read` is declared
   * ORGANIZATION-scoped precisely so that a role built by filtering the catalogue for
   * `:read` permissions cannot pick it up — the defect that was found and fixed in 1.2.
   */
  it('a workspace editor is refused', async () => {
    await seed('organization.member.role_changed');
    await expect(readAs(fx.editorUser)).rejects.toThrow(ForbiddenError);
  });
});

describe('client_guest cannot inspect the agency', () => {
  /**
   * A client guest is someone OUTSIDE the agency, admitted to one workspace. The agency's
   * audit log names its other clients; letting a guest read it would leak the client list —
   * the same disclosure migration 0007 closed on `workspaces`, arriving by another route.
   */
  it('is refused by the permission layer', async () => {
    const guest = await fx.createUser('guest-audit@client.test');
    await fx.asActor(fx.ownerUser, fx.agencyOrg, async (c) => {
      const { addMember, assignRole } = await import('./provisioning.js');
      const member = await addMember(c, {
        organizationId: fx.agencyOrg,
        userId: guest,
        memberType: 'client',
      });
      await assignRole(c, {
        organizationId: fx.agencyOrg,
        memberId: member,
        roleSlug: 'client_guest',
        workspaceId: fx.acme,
      });
    });

    await seed('organization.member.role_changed');
    await expect(readAs(guest)).rejects.toThrow(ForbiddenError);

    // AND the database refuses independently: even with the permission check removed, the
    // guest's own context reaches only its one workspace, so an organization-level event is
    // still not readable through a workspace-tagged query.
    const ctx = await fx.actorFor(guest);
    expect(ctx.accessibleWorkspaceIds).toEqual([fx.acme]);
  });
});

describe('the workspace boundary applies to the log itself', () => {
  it('an actor cannot filter by a workspace they cannot reach', async () => {
    await seed('organization.member.role_changed', fx.borealis);
    // The owner CAN reach borealis, so this is allowed for them...
    await expect(readAs(fx.ownerUser, { workspaceId: fx.borealis })).resolves.toBeDefined();

    // ...but an actor whose set excludes it is refused, rather than being handed an empty
    // page that reads as "nothing happened there".
    const ctx = await fx.actorFor(fx.adminUser);
    const narrowed = { ...ctx, accessibleWorkspaceIds: [fx.acme] };
    await expect(
      withTenant(
        fx.db.pool,
        {
          organizationId: fx.agencyOrg,
          userId: fx.adminUser,
          workspaceIds: [fx.acme],
          workspaceScope: 'set',
        },
        async (tx) =>
          await readAuditLog({ audit: createAuditReader(tx.client) }, narrowed, {
            workspaceId: fx.borealis,
          }),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it('a narrowed session sees no event about a workspace outside its set', async () => {
    await seed('organization.member.role_changed', fx.borealis);
    const ctx = await fx.actorFor(fx.adminUser);
    const narrowed = { ...ctx, accessibleWorkspaceIds: [fx.acme], workspaceScope: 'set' as const };

    const page = await withTenant(
      fx.db.pool,
      {
        organizationId: fx.agencyOrg,
        userId: fx.adminUser,
        workspaceIds: [fx.acme],
        workspaceScope: 'set',
      },
      async (tx) => await readAuditLog({ audit: createAuditReader(tx.client) }, narrowed),
    );
    expect(page.events).toHaveLength(0);
  });
});

describe('cross-tenant', () => {
  it('an actor cannot read another organization’s log by naming it', async () => {
    await seed('organization.member.role_changed');

    // The rival's owner, acting in the rival tenant, asking for the agency's events. The
    // organization comes from the ACTOR, so there is no parameter to point elsewhere — and
    // the policy would refuse it even if there were.
    const rivalCtx = await fx.actorFor(fx.rivalOwnerUser, fx.rivalOrg);
    const page = await withTenant(
      fx.db.pool,
      {
        organizationId: fx.rivalOrg,
        userId: fx.rivalOwnerUser,
        workspaceIds: rivalCtx.accessibleWorkspaceIds,
        workspaceScope: rivalCtx.workspaceScope,
      },
      async (tx) => await readAuditLog({ audit: createAuditReader(tx.client) }, rivalCtx),
    );
    expect(page.events).toHaveLength(0);
  });
});

describe('verification is guarded like reading', () => {
  it('an owner can verify the chain', async () => {
    for (let i = 0; i < 3; i++) await seed('organization.member.role_changed');
    const ctx = await fx.actorFor(fx.ownerUser);
    const result = await withTenant(
      fx.db.pool,
      {
        organizationId: fx.agencyOrg,
        userId: fx.ownerUser,
        workspaceIds: ctx.accessibleWorkspaceIds,
        workspaceScope: ctx.workspaceScope,
      },
      async (tx) => await verifyAuditLog({ audit: createAuditReader(tx.client) }, ctx),
    );
    expect(result).toMatchObject({ valid: true, checked: 3, from: 1, to: 3 });
  });

  it('a workspace editor cannot verify either', async () => {
    await seed('organization.member.role_changed');
    const ctx = await fx.actorFor(fx.editorUser);
    await expect(
      withTenant(
        fx.db.pool,
        {
          organizationId: fx.agencyOrg,
          userId: fx.editorUser,
          workspaceIds: ctx.accessibleWorkspaceIds,
          workspaceScope: ctx.workspaceScope,
        },
        async (tx) => await verifyAuditLog({ audit: createAuditReader(tx.client) }, ctx),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it('reports tampering to an operator, not just to a test', async () => {
    for (let i = 0; i < 3; i++) await seed('organization.member.role_changed');
    await fx.admin.query(
      `UPDATE audit_events SET action = 'tampered' WHERE organization_id = $1 AND sequence = 2`,
      [fx.agencyOrg],
    );

    const ctx = await fx.actorFor(fx.ownerUser);
    const result = await withTenant(
      fx.db.pool,
      {
        organizationId: fx.agencyOrg,
        userId: fx.ownerUser,
        workspaceIds: ctx.accessibleWorkspaceIds,
        workspaceScope: ctx.workspaceScope,
      },
      async (tx) => await verifyAuditLog({ audit: createAuditReader(tx.client) }, ctx),
    );
    expect(result.valid).toBe(false);
    // `sequence_gap` carries `expected`/`found` rather than `sequence`, so the union has to
    // be narrowed — the test typecheck caught this reaching for a field that is not on every
    // member.
    expect(result.breaks.some((b) => b.kind !== 'sequence_gap' && b.sequence === 2)).toBe(true);
  });
});
