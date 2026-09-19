/**
 * Administering overrides: permission, audit and effect.
 *
 * These are the "administrative overrides" an investigation asks about — who granted this
 * customer that capability, when, and why — so the audit record is asserted as carefully as
 * the entitlement change itself.
 */

import { randomUUID } from 'node:crypto';
import { createAuditSink } from '@growth-os/audit';
import type { ActorContext } from '@growth-os/authz';
import { ForbiddenError, ValidationError } from '@growth-os/errors';
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from '@growth-os/testing';
import { Client, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { grantOverride, removeOverride } from './administration.js';
import {
  createOverrideRepository,
  createPlanFeatureReader,
  createSubscriptionReader,
  createUsageRepository,
} from './repositories.js';
import { createEntitlementService } from './service.js';

let db: TestDatabase;
let admin: Client;

const ORG = '01990000-0000-7000-8000-000000009001';
const WS = '01990000-0000-7000-8000-000000009002';
const USER = '01990000-0000-7000-8000-000000009003';
const clock = { now: () => new Date('2026-09-19T12:00:00.000Z') };

/** An organization-scoped actor holding the billing permission an override requires. */
function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    kind: 'user',
    userId: USER,
    organizationId: ORG,
    organizationMemberId: randomUUID(),
    organizationStatus: 'active',
    assignments: [{ roleId: 'billing', permissions: ['billing.subscription:manage'] }],
    resourceGrants: [],
    accessibleWorkspaceIds: [WS],
    workspaceScope: 'all',
    teamIds: [],
    workspacesByTeam: new Map(),
    mfaSatisfied: true,
    mfaRequired: false,
    impersonated: false,
    apiKeyScopes: [],
    ...overrides,
  };
}

async function inTenant<T>(body: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.organization_id', ORG]);
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_ids', `{${WS}}`]);
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_scope', 'all']);
    const value = await body(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const adminDeps = (c: PoolClient) => ({
  overrides: createOverrideRepository(c),
  audit: createAuditSink(c, { now: clock.now, requireTransaction: true }),
  clock,
});

const serviceOn = (c: PoolClient) =>
  createEntitlementService({
    subscriptions: createSubscriptionReader(c),
    planFeatures: createPlanFeatureReader(c),
    overrides: createOverrideRepository(c),
    usage: createUsageRepository(c),
    clock,
  });

async function auditRows() {
  const r = await admin.query<{
    action: string;
    metadata: Record<string, unknown>;
    result: string;
  }>(
    `SELECT action, metadata, result FROM audit_events WHERE organization_id = $1 ORDER BY sequence`,
    [ORG],
  );
  return r.rows;
}

beforeAll(async () => {
  db = await acquireTestDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();
  await admin.query(
    `INSERT INTO organizations (id, name, slug, kind, status)
     VALUES ($1, 'Admin Co', 'admin-co', 'agency', 'active')`,
    [ORG],
  );
  const team = randomUUID();
  await admin.query(
    `INSERT INTO teams (id, organization_id, slug, name) VALUES ($1, $2, 'pod', 'Pod')`,
    [team, ORG],
  );
  await admin.query(
    `INSERT INTO workspaces (id, organization_id, team_id, slug, name)
     VALUES ($1, $2, $3, 'acme', 'Acme')`,
    [WS, ORG, team],
  );
  await admin.query(
    `INSERT INTO users (id, email, status) VALUES ($1, 'admin@co.test', 'active')`,
    [USER],
  );
}, 180_000);

afterAll(async () => {
  await admin.end();
  await db.close();
  await stopSharedCluster();
});

beforeEach(async () => {
  await admin.query('DELETE FROM audit_events');
  await admin.query('DELETE FROM audit_chain_heads');
  await admin.query('DELETE FROM entitlement_overrides');
});

describe('granting', () => {
  it('takes effect immediately — there is no cache to wait for', async () => {
    const before = await inTenant(async (c) =>
      serviceOn(c).resolve({ organizationId: ORG, capabilityKey: 'ai.agents' }),
    );
    expect(before.enabled).toBe(false);

    await inTenant(async (c) =>
      grantOverride(adminDeps(c), {
        actor: actor(),
        capabilityKey: 'ai.agents',
        enabled: true,
        isUnlimited: true,
        reason: 'enterprise agreement 2026-Q3',
      }),
    );

    const after = await inTenant(async (c) =>
      serviceOn(c).resolve({ organizationId: ORG, capabilityKey: 'ai.agents' }),
    );
    expect(after.enabled).toBe(true);
    expect(after.source).toBe('organization_override');
  });

  it('audits the grant with the capability, shape and stated reason', async () => {
    await inTenant(async (c) =>
      grantOverride(adminDeps(c), {
        actor: actor(),
        capabilityKey: 'ai.agents',
        enabled: true,
        limitValue: 500,
        reason: 'enterprise agreement 2026-Q3',
      }),
    );
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('entitlements.override.granted');
    expect(rows[0]?.metadata).toMatchObject({
      capability: 'ai.agents',
      enabled: true,
      limit: 500,
      reason: 'enterprise agreement 2026-Q3',
      scope: 'organization',
    });
  });

  /**
   * REVOCATION IS ITS OWN ACTION, not a grant with a false flag: "every capability withdrawn
   * last quarter" should be a query on `action`, not a scan of metadata.
   */
  it('a disabling override is audited as a revocation and takes effect immediately', async () => {
    await inTenant(async (c) =>
      grantOverride(adminDeps(c), {
        actor: actor(),
        capabilityKey: 'marketplace.buying',
        enabled: false,
        reason: 'chargeback investigation',
      }),
    );
    expect((await auditRows())[0]?.action).toBe('entitlements.override.revoked');

    const decision = await inTenant(async (c) =>
      serviceOn(c).resolve({ organizationId: ORG, capabilityKey: 'marketplace.buying' }),
    );
    // The catalogue default enables buying; the override withdraws it.
    expect(decision.enabled).toBe(false);
    expect(decision.source).toBe('organization_override');
  });
});

describe('revoking and removing', () => {
  it('removing an override returns the decision to the default, and is audited', async () => {
    await inTenant(async (c) =>
      grantOverride(adminDeps(c), {
        actor: actor(),
        capabilityKey: 'ai.agents',
        enabled: true,
        isUnlimited: true,
        reason: 'pilot',
      }),
    );
    await inTenant(async (c) => removeOverride(adminDeps(c), actor(), 'ai.agents'));

    const decision = await inTenant(async (c) =>
      serviceOn(c).resolve({ organizationId: ORG, capabilityKey: 'ai.agents' }),
    );
    expect(decision.source).toBe('default');
    expect(decision.enabled).toBe(false);
    expect((await auditRows()).map((r) => r.action)).toEqual([
      'entitlements.override.granted',
      'entitlements.override.removed',
    ]);
  });

  it('the override and its audit event commit together', async () => {
    await expect(
      inTenant(async (c) => {
        await grantOverride(adminDeps(c), {
          actor: actor(),
          capabilityKey: 'ai.agents',
          enabled: true,
          isUnlimited: true,
          reason: 'pilot',
        });
        throw new Error('the surrounding operation failed');
      }),
    ).rejects.toThrow(/surrounding operation failed/);

    expect((await admin.query('SELECT 1 FROM entitlement_overrides')).rowCount).toBe(0);
    expect(await auditRows()).toEqual([]);
  });
});

describe('authorization', () => {
  it('refuses an actor without the billing permission, and writes nothing', async () => {
    const editor = actor({
      assignments: [{ roleId: 'editor', permissions: ['social.post:create'] }],
    });
    await expect(
      inTenant(async (c) =>
        grantOverride(adminDeps(c), {
          actor: editor,
          capabilityKey: 'ai.agents',
          enabled: true,
          isUnlimited: true,
          reason: 'self-service upgrade',
        }),
      ),
    ).rejects.toThrow(ForbiddenError);
    expect((await admin.query('SELECT 1 FROM entitlement_overrides')).rowCount).toBe(0);
    expect(await auditRows()).toEqual([]);
  });

  it('refuses a workspace the actor cannot reach', async () => {
    await expect(
      inTenant(async (c) =>
        grantOverride(adminDeps(c), {
          actor: actor({ accessibleWorkspaceIds: [] }),
          workspaceId: WS,
          capabilityKey: 'social.analytics',
          enabled: true,
          isUnlimited: true,
          reason: 'client pilot',
        }),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses an unknown capability rather than storing a key nothing consults', async () => {
    await expect(
      inTenant(async (c) =>
        grantOverride(adminDeps(c), {
          actor: actor(),
          capabilityKey: 'ai.agnets',
          enabled: true,
          isUnlimited: true,
          reason: 'typo',
        }),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses an override with no stated reason', async () => {
    await expect(
      inTenant(async (c) =>
        grantOverride(adminDeps(c), {
          actor: actor(),
          capabilityKey: 'ai.agents',
          enabled: true,
          isUnlimited: true,
          reason: '   ',
        }),
      ),
    ).rejects.toThrow(ValidationError);
  });
});
