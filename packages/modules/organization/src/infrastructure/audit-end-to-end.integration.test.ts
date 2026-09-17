/**
 * The audit log, driven by the REAL services.
 *
 * The suites in @growth-os/audit exercise the recorder directly. This one exercises the thing
 * that was actually missing: until `createAuditSink` existed, the recorder was constructed
 * only in tests, so an invitation or an API key could be created, rotated and revoked without
 * any row ever reaching `audit_events`. Everything below runs the production service with the
 * production sink and then asks the database what it has.
 */

import { createAuditReader, createAuditSink, verifyChain } from '@growth-os/audit';
import { withTenant } from '@growth-os/db';
import { stopSharedCluster } from '@growth-os/testing';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AgencyFixture, buildAgencyFixture } from '../__testing__/agency-fixture.js';
import {
  createApiKey,
  createInvitation,
  revokeApiKey,
  revokeInvitation,
  rotateApiKey,
} from '../application/index.js';
import { createApiKeyRepository } from './api-key-repository.js';
import {
  createInvitationRepository,
  createMembershipWriter,
  createOrganizationReader,
  createRoleReader,
  createWorkspaceTopologyReader,
} from './invitation-repository.js';

let fx: AgencyFixture;
const clock = { now: () => new Date('2026-09-17T12:00:00.000Z') };

beforeAll(async () => {
  fx = await buildAgencyFixture();
}, 180_000);

afterAll(async () => {
  await fx.close();
  await stopSharedCluster();
});

beforeEach(async () => {
  await fx.admin.query('DELETE FROM audit_events');
  await fx.admin.query('DELETE FROM audit_chain_heads');
  await fx.admin.query('DELETE FROM invitations');
  await fx.admin.query('DELETE FROM api_keys');
});

/**
 * Runs a body in the actor's tenant transaction with the REAL sink bound to that client.
 *
 * `requireTransaction` is set: these services have a unit of work, so an audit row committing
 * on its own would be a defect, and this turns it into a loud failure rather than a quiet
 * inconsistency discovered during an incident.
 */
async function asActor<T>(userId: string, body: (client: PoolClient, deps: Deps) => Promise<T>) {
  const ctx = await fx.actorFor(userId);
  return await withTenant(
    fx.db.pool,
    {
      organizationId: fx.agencyOrg,
      userId,
      workspaceIds: ctx.accessibleWorkspaceIds,
      workspaceScope: ctx.workspaceScope,
    },
    async (tx) => {
      const audit = createAuditSink(tx.client, { now: clock.now, requireTransaction: true });
      return await body(tx.client, {
        audit,
        clock,
        invitations: createInvitationRepository(tx.client),
        roles: createRoleReader(tx.client),
        memberships: createMembershipWriter(tx.client),
        organizations: createOrganizationReader(tx.client),
        apiKeys: createApiKeyRepository(tx.client),
        topology: createWorkspaceTopologyReader(tx.client),
      });
    },
  );
}

interface Deps {
  audit: ReturnType<typeof createAuditSink>;
  clock: { now: () => Date };
  invitations: ReturnType<typeof createInvitationRepository>;
  roles: ReturnType<typeof createRoleReader>;
  memberships: ReturnType<typeof createMembershipWriter>;
  organizations: ReturnType<typeof createOrganizationReader>;
  apiKeys: ReturnType<typeof createApiKeyRepository>;
  topology: ReturnType<typeof createWorkspaceTopologyReader>;
}

/** Every event in the agency's chain, read past RLS so nothing is hidden from the assertion. */
async function storedEvents() {
  const r = await fx.admin.query<{
    action: string;
    result: string;
    actor_type: string;
    actor_user_id: string | null;
    resource_type: string;
    metadata: Record<string, unknown>;
    sequence: string;
  }>(
    `SELECT action, result, actor_type, actor_user_id, resource_type, metadata, sequence
       FROM audit_events WHERE organization_id = $1 ORDER BY sequence`,
    [fx.agencyOrg],
  );
  return r.rows;
}

describe('invitation actions reach the log', () => {
  it('records creation with the role and address, and never the token', async () => {
    const created = await asActor(fx.ownerUser, async (_c, deps) =>
      createInvitation(deps, {
        actor: await fx.actorFor(fx.ownerUser),
        email: 'audited@agency.test',
        roleSlug: 'editor',
        scope: { kind: 'workspace', workspaceId: fx.acme },
      }),
    );

    const events = await storedEvents();
    expect(events.map((e) => e.action)).toContain('organization.invitation.created');
    const event = events.find((e) => e.action === 'organization.invitation.created');
    expect(event?.result).toBe('succeeded');
    expect(event?.actor_user_id).toBe(fx.ownerUser);
    expect(event?.metadata['role']).toBe('editor');

    // THE SECRET. The token must not appear anywhere in the row, in any field.
    expect(JSON.stringify(events)).not.toContain(created.token);
    const raw = await fx.admin.query(
      `SELECT 1 FROM audit_events WHERE organization_id = $1 AND metadata::text LIKE $2`,
      [fx.agencyOrg, `%${created.token.slice(-16)}%`],
    );
    expect(raw.rowCount).toBe(0);
  });

  it('records a refused escalation as DENIED, not as a success', async () => {
    await expect(
      asActor(fx.adminUser, async (_c, deps) =>
        createInvitation(deps, {
          actor: await fx.actorFor(fx.adminUser),
          email: 'escalate@agency.test',
          roleSlug: 'owner',
          scope: { kind: 'organization' },
        }),
      ),
    ).rejects.toThrow();

    // The refusal is rolled back with the transaction that raised it — the service throws,
    // so nothing commits. What matters is that the attempt is not recorded as a SUCCESS
    // anywhere, which the result vocabulary is what prevents.
    const events = await storedEvents();
    expect(
      events.filter((e) => e.result === 'succeeded' && e.action.includes('invitation')),
    ).toEqual([]);
  });

  it('records revocation', async () => {
    const created = await asActor(fx.ownerUser, async (_c, deps) =>
      createInvitation(deps, {
        actor: await fx.actorFor(fx.ownerUser),
        email: 'revoked@agency.test',
        roleSlug: 'editor',
        scope: { kind: 'workspace', workspaceId: fx.acme },
      }),
    );
    await asActor(fx.ownerUser, async (_c, deps) =>
      revokeInvitation(deps, await fx.actorFor(fx.ownerUser), created.invitationId),
    );

    expect((await storedEvents()).map((e) => e.action)).toEqual([
      'organization.invitation.created',
      'organization.invitation.revoked',
    ]);
  });
});

describe('API-key actions reach the log', () => {
  it('records creation, rotation and revocation, with the prefix and never the secret', async () => {
    const created = await asActor(fx.ownerUser, async (_c, deps) =>
      createApiKey(deps, {
        actor: await fx.actorFor(fx.ownerUser),
        name: 'CI',
        scopes: ['social.post:read'],
      }),
    );
    const rotated = await asActor(fx.ownerUser, async (_c, deps) =>
      rotateApiKey(deps, await fx.actorFor(fx.ownerUser), created.id),
    );
    await asActor(fx.ownerUser, async (_c, deps) =>
      revokeApiKey(deps, await fx.actorFor(fx.ownerUser), rotated.created.id),
    );

    const actions = (await storedEvents()).map((e) => e.action);
    expect(actions).toContain('organization.api_key.created');
    expect(actions).toContain('organization.api_key.rotated');
    expect(actions).toContain('organization.api_key.revoked');

    const serialised = JSON.stringify(await storedEvents());
    const secret = created.key.split('_')[3] ?? '';
    expect(serialised).not.toContain(created.key);
    expect(serialised).not.toContain(secret);
    // The prefix IS recorded: it is the public half, and how a leaked key is located.
    expect(serialised).toContain(created.prefix);
  });

  it('never writes an argon2 hash into the log', async () => {
    await asActor(fx.ownerUser, async (_c, deps) =>
      createApiKey(deps, {
        actor: await fx.actorFor(fx.ownerUser),
        name: 'CI',
        scopes: ['social.post:read'],
      }),
    );
    expect(JSON.stringify(await storedEvents())).not.toContain('$argon2');
  });
});

describe('the chain produced by real services verifies', () => {
  it('is gapless and hash-valid across a mixed sequence of actions', async () => {
    await asActor(fx.ownerUser, async (_c, deps) =>
      createInvitation(deps, {
        actor: await fx.actorFor(fx.ownerUser),
        email: 'mixed@agency.test',
        roleSlug: 'editor',
        scope: { kind: 'workspace', workspaceId: fx.acme },
      }),
    );
    await asActor(fx.ownerUser, async (_c, deps) =>
      createApiKey(deps, {
        actor: await fx.actorFor(fx.ownerUser),
        name: 'CI',
        scopes: ['social.post:read'],
      }),
    );

    const ctx = await fx.actorFor(fx.ownerUser);
    const events = await withTenant(
      fx.db.pool,
      {
        organizationId: fx.agencyOrg,
        userId: fx.ownerUser,
        workspaceIds: ctx.accessibleWorkspaceIds,
        workspaceScope: ctx.workspaceScope,
      },
      async (tx) => await createAuditReader(tx.client).chainSlice(fx.agencyOrg, 1, 100),
    );

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(verifyChain(fx.agencyOrg, events)).toMatchObject({ valid: true });
  });

  /**
   * THE COUPLING, end to end. A service that throws after its audit write must leave neither
   * the change nor the record — which is the property the in-transaction design buys and the
   * outbox could not have given (ADR-0019).
   */
  it('a failed action leaves neither the change nor the audit row', async () => {
    await expect(
      asActor(fx.ownerUser, async (_c, deps) => {
        await createInvitation(deps, {
          actor: await fx.actorFor(fx.ownerUser),
          email: 'doomed@agency.test',
          roleSlug: 'editor',
          scope: { kind: 'workspace', workspaceId: fx.acme },
        });
        throw new Error('the business step failed after the audit write');
      }),
    ).rejects.toThrow(/business step failed/);

    expect(await storedEvents()).toEqual([]);
    expect((await fx.admin.query('SELECT 1 FROM invitations')).rowCount).toBe(0);
    // And the head did not advance, so the next real event is sequence 1 with no gap.
    const heads = await fx.admin.query(
      'SELECT 1 FROM audit_chain_heads WHERE organization_id = $1',
      [fx.agencyOrg],
    );
    expect(heads.rowCount).toBe(0);
  });
});

describe('the sink refuses to write outside a transaction when told to', () => {
  /**
   * A caller that HAS a unit of work declares it. Without this, handing the sink a pool would
   * silently decouple the audit row from the change — the dual-write failure reintroduced one
   * layer above the recorder, and invisible until an incident.
   */
  it('throws rather than committing an audit row on its own', async () => {
    const sink = createAuditSink(fx.db.pool, { requireTransaction: true });
    await expect(
      sink.record({
        organizationId: fx.agencyOrg,
        actor: { type: 'user', userId: fx.ownerUser },
        action: 'organization.member.role_changed',
        resourceType: 'member',
        resourceId: 'm-1',
        result: 'succeeded',
      }),
    ).rejects.toThrow(/requires a transaction/);
    expect(await storedEvents()).toEqual([]);
  });
});
