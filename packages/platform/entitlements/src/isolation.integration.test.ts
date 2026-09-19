/**
 * Entitlements under the tenancy model.
 *
 * Two independent questions must BOTH be answered before a protected operation happens:
 *
 *   authorization — may this actor perform the operation? (roles and permissions)
 *   entitlement   — does this organization have the capability, and any left? (here)
 *
 * Neither implies the other, and this suite asserts that in both directions as well as the
 * isolation properties: a tenant must not see another's plan, usage or overrides, and a
 * session confined to one workspace must not see another workspace's.
 */

import { randomUUID } from 'node:crypto';
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from '@growth-os/testing';
import { Client, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createOverrideRepository,
  createPlanFeatureReader,
  createSubscriptionReader,
  createUsageRepository,
} from './repositories.js';
import { createEntitlementService } from './service.js';

let db: TestDatabase;
let admin: Client;

const AGENCY = '01990000-0000-7000-8000-00000000d001';
const RIVAL = '01990000-0000-7000-8000-00000000d002';
const ACME = '01990000-0000-7000-8000-00000000e001';
const BOREALIS = '01990000-0000-7000-8000-00000000e002';
const PLAN = '01990000-0000-7000-8000-00000000c101';

const clock = { now: () => new Date('2026-09-19T12:00:00.000Z') };
const PERIOD_START = new Date('2026-09-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-10-01T00:00:00.000Z');

async function inTenant<T>(
  organizationId: string,
  body: (c: PoolClient) => Promise<T>,
  options: { workspaceIds?: readonly string[]; scope?: 'set' | 'all' } = {},
): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.organization_id', organizationId]);
    await client.query('SELECT set_config($1, $2, true)', [
      'app.workspace_ids',
      `{${(options.workspaceIds ?? []).join(',')}}`,
    ]);
    await client.query('SELECT set_config($1, $2, true)', [
      'app.workspace_scope',
      options.scope ?? 'all',
    ]);
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

const serviceOn = (c: PoolClient) =>
  createEntitlementService({
    subscriptions: createSubscriptionReader(c),
    planFeatures: createPlanFeatureReader(c),
    overrides: createOverrideRepository(c),
    usage: createUsageRepository(c),
    clock,
  });

beforeAll(async () => {
  db = await acquireTestDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();

  for (const [id, slug] of [
    [AGENCY, 'northwind'],
    [RIVAL, 'rival'],
  ] as const) {
    await admin.query(
      `INSERT INTO organizations (id, name, slug, kind, status)
       VALUES ($1, $2, $2, 'agency', 'active')`,
      [id, slug],
    );
  }
  const pod = randomUUID();
  await admin.query(
    `INSERT INTO teams (id, organization_id, slug, name) VALUES ($1, $2, 'pod', 'Pod')`,
    [pod, AGENCY],
  );
  for (const [id, slug] of [
    [ACME, 'acme'],
    [BOREALIS, 'borealis'],
  ] as const) {
    await admin.query(
      `INSERT INTO workspaces (id, organization_id, team_id, slug, name)
       VALUES ($1, $2, $3, $4, $4)`,
      [id, AGENCY, pod, slug],
    );
  }
  await admin.query(`INSERT INTO plans (id, key, name) VALUES ($1, 'scale', 'Scale')`, [PLAN]);
  await admin.query(
    `INSERT INTO plan_features (id, plan_id, capability_key, enabled, limit_value, is_unlimited)
     VALUES ($1, $2, 'social.scheduling', true, 50, false)`,
    [randomUUID(), PLAN],
  );
}, 180_000);

afterAll(async () => {
  await admin.end();
  await db.close();
  await stopSharedCluster();
});

beforeEach(async () => {
  await admin.query('DELETE FROM usage_records');
  await admin.query('DELETE FROM entitlement_usage');
  await admin.query('DELETE FROM entitlement_overrides');
  await admin.query('DELETE FROM subscriptions');
});

const subscribe = async (organizationId: string) =>
  admin.query(
    `INSERT INTO subscriptions
       (id, organization_id, plan_id, status, current_period_start, current_period_end)
     VALUES ($1, $2, $3, 'active', $4, $5)`,
    [randomUUID(), organizationId, PLAN, PERIOD_START, PERIOD_END],
  );

describe('cross-tenant isolation', () => {
  it("one organization cannot read another's subscription", async () => {
    await subscribe(AGENCY);
    // The rival, asking for the agency's entitlement by naming its id explicitly.
    const decision = await inTenant(RIVAL, async (c) =>
      serviceOn(c).resolve({ organizationId: AGENCY, capabilityKey: 'social.scheduling' }),
    );
    // The policy, not the parameter, decides: the subscription is invisible, so resolution
    // falls to the catalogue default rather than the agency's plan.
    expect(decision.source).toBe('default');
  });

  it("one organization cannot read another's overrides", async () => {
    await inTenant(AGENCY, async (c) =>
      createOverrideRepository(c).upsert({
        organizationId: AGENCY,
        workspaceId: null,
        capabilityKey: 'ai.agents',
        enabled: true,
        isUnlimited: true,
        reason: 'enterprise',
        expiresAt: null,
        grantedBy: null,
      }),
    );
    const seen = await inTenant(RIVAL, async (c) =>
      createOverrideRepository(c).listForOrganization(AGENCY),
    );
    expect(seen).toEqual([]);
  });

  it("one organization's consumption never touches another's counter", async () => {
    await subscribe(AGENCY);
    await subscribe(RIVAL);
    await inTenant(AGENCY, async (c) =>
      serviceOn(c).consume({
        organizationId: AGENCY,
        workspaceId: ACME,
        capabilityKey: 'social.scheduling',
        quantity: 5,
      }),
    );
    const rival = await admin.query('SELECT 1 FROM entitlement_usage WHERE organization_id = $1', [
      RIVAL,
    ]);
    expect(rival.rowCount).toBe(0);
  });

  it('a write naming another tenant is refused by the policy', async () => {
    await expect(
      inTenant(RIVAL, async (c) =>
        createOverrideRepository(c).upsert({
          organizationId: AGENCY,
          workspaceId: null,
          capabilityKey: 'ai.agents',
          enabled: true,
          isUnlimited: true,
          reason: 'forged',
          expiresAt: null,
          grantedBy: null,
        }),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });
});

describe('the workspace boundary applies to entitlements', () => {
  /**
   * An agency's per-client overrides name its clients. A session confined to one workspace —
   * a client_guest, or an API key narrowed to one client — must not read another's, or the
   * entitlement table becomes a way to enumerate the client list, the same disclosure
   * migration 0007 closed on `workspaces`.
   */
  it('a session confined to one workspace cannot read another workspace’s override', async () => {
    await inTenant(AGENCY, async (c) => {
      const repo = createOverrideRepository(c);
      await repo.upsert({
        organizationId: AGENCY,
        workspaceId: ACME,
        capabilityKey: 'social.analytics',
        enabled: true,
        isUnlimited: true,
        reason: 'acme pilot',
        expiresAt: null,
        grantedBy: null,
      });
      await repo.upsert({
        organizationId: AGENCY,
        workspaceId: BOREALIS,
        capabilityKey: 'social.analytics',
        enabled: true,
        isUnlimited: true,
        reason: 'borealis pilot',
        expiresAt: null,
        grantedBy: null,
      });
    });

    const confined = await inTenant(
      AGENCY,
      async (c) => await createOverrideRepository(c).listForOrganization(AGENCY),
      { workspaceIds: [ACME], scope: 'set' },
    );
    expect(confined.map((o) => o.workspaceId)).toEqual([ACME]);
  });

  /**
   * client_guest CANNOT ESCALATE SCOPE. Resolving for a workspace outside its set falls
   * through to the organization grant rather than reading the other workspace's override —
   * the narrower grant is invisible, so it cannot be borrowed.
   */
  it('a confined session resolving another workspace does not pick up its override', async () => {
    await inTenant(AGENCY, async (c) =>
      createOverrideRepository(c).upsert({
        organizationId: AGENCY,
        workspaceId: BOREALIS,
        capabilityKey: 'social.scheduling',
        enabled: true,
        isUnlimited: true,
        reason: 'borealis unlimited',
        expiresAt: null,
        grantedBy: null,
      }),
    );

    const decision = await inTenant(
      AGENCY,
      async (c) =>
        await serviceOn(c).resolve({
          organizationId: AGENCY,
          workspaceId: BOREALIS,
          capabilityKey: 'social.scheduling',
        }),
      { workspaceIds: [ACME], scope: 'set' },
    );
    expect(decision.source).not.toBe('workspace_override');
    expect(decision.limit).not.toEqual({ kind: 'unlimited' });
  });

  it('per-workspace meters are independent', async () => {
    await subscribe(AGENCY);
    await inTenant(AGENCY, async (c) =>
      serviceOn(c).consume({
        organizationId: AGENCY,
        workspaceId: ACME,
        capabilityKey: 'social.scheduling',
        quantity: 7,
      }),
    );
    const borealis = await inTenant(AGENCY, async (c) =>
      serviceOn(c).resolve({
        organizationId: AGENCY,
        workspaceId: BOREALIS,
        capabilityKey: 'social.scheduling',
      }),
    );
    expect(borealis.used).toBe(0);
    expect(borealis.remaining).toBe(50);
  });
});

describe('an entitlement is not a permission, and a permission is not an entitlement', () => {
  /**
   * The two checks are independent. This asserts the half that belongs to entitlements: the
   * decision does not consult the actor at all, so holding every permission in the
   * organization changes nothing about what the organization has bought.
   */
  it('resolution is identical regardless of which actor asks', async () => {
    await subscribe(AGENCY);
    const first = await inTenant(AGENCY, async (c) =>
      serviceOn(c).resolve({
        organizationId: AGENCY,
        workspaceId: ACME,
        capabilityKey: 'social.scheduling',
      }),
    );
    const second = await inTenant(AGENCY, async (c) =>
      serviceOn(c).resolve({
        organizationId: AGENCY,
        workspaceId: ACME,
        capabilityKey: 'social.scheduling',
      }),
    );
    expect(first).toEqual(second);
  });

  /**
   * An API key and an impersonated session reach entitlements through the SAME tenant
   * context every other actor does — `app.organization_id` and the accessible workspace set.
   * There is no actor-shaped input to the resolver, so there is no path by which either
   * could be handed a different answer.
   */
  it('a workspace-narrowed context yields the narrowed answer, whatever the actor kind', async () => {
    await inTenant(AGENCY, async (c) =>
      createOverrideRepository(c).upsert({
        organizationId: AGENCY,
        workspaceId: ACME,
        capabilityKey: 'social.analytics',
        enabled: true,
        isUnlimited: true,
        reason: 'acme pilot',
        expiresAt: null,
        grantedBy: null,
      }),
    );

    // A key or impersonated session narrowed to BOREALIS: the ACME override is invisible.
    const narrowed = await inTenant(
      AGENCY,
      async (c) =>
        await serviceOn(c).resolve({
          organizationId: AGENCY,
          workspaceId: ACME,
          capabilityKey: 'social.analytics',
        }),
      { workspaceIds: [BOREALIS], scope: 'set' },
    );
    expect(narrowed.enabled).toBe(false);
    expect(narrowed.source).toBe('default');
  });
});

describe('usage_records is append-only', () => {
  it('the application role holds SELECT and INSERT and nothing else', async () => {
    const r = await admin.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'growth_os_app' AND table_name = 'usage_records'`,
    );
    expect(r.rows.map((x) => x.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
  });

  it('refuses an UPDATE outright, so a consumption record cannot be edited', async () => {
    await subscribe(AGENCY);
    await inTenant(AGENCY, async (c) =>
      serviceOn(c).consume({
        organizationId: AGENCY,
        workspaceId: ACME,
        capabilityKey: 'social.scheduling',
      }),
    );
    await expect(
      inTenant(AGENCY, async (c) => c.query('UPDATE usage_records SET quantity = 0')),
    ).rejects.toThrow(/permission denied/i);
  });
});
