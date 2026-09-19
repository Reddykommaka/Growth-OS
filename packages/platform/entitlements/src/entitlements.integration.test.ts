/**
 * Entitlements against real PostgreSQL.
 *
 * The properties here are properties OF THE DATABASE: the atomic consume that makes
 * concurrent gating safe, the RLS that keeps one tenant's plan and usage invisible to
 * another, and the workspace boundary applied to overrides and meters. None can be
 * established with a mock.
 */

import { randomUUID } from 'node:crypto';
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from '@growth-os/testing';
import { Client, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capabilityKeys, unknownCapabilityKeys } from './catalogue.js';
import {
  createOverrideRepository,
  createPlanFeatureReader,
  createSubscriptionReader,
  createUsageRepository,
} from './repositories.js';
import { createEntitlementService } from './service.js';

let db: TestDatabase;
let admin: Client;

const ORG_A = '01990000-0000-7000-8000-00000000a001';
const ORG_B = '01990000-0000-7000-8000-00000000b001';
const WS_1 = '01990000-0000-7000-8000-00000000f001';
const WS_2 = '01990000-0000-7000-8000-00000000f002';
const PLAN_STARTER = '01990000-0000-7000-8000-00000000c001';
const PLAN_SCALE = '01990000-0000-7000-8000-00000000c002';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const clock = { now: () => NOW };
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

function serviceOn(client: PoolClient) {
  return createEntitlementService({
    subscriptions: createSubscriptionReader(client),
    planFeatures: createPlanFeatureReader(client),
    overrides: createOverrideRepository(client),
    usage: createUsageRepository(client),
    clock,
  });
}

beforeAll(async () => {
  db = await acquireTestDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();

  for (const [id, org] of [
    [ORG_A, 'alpha'],
    [ORG_B, 'beta'],
  ] as const) {
    await admin.query(
      `INSERT INTO organizations (id, name, slug, kind, status)
       VALUES ($1, $2, $2, 'agency', 'active')`,
      [id, org],
    );
  }
  const team = randomUUID();
  await admin.query(
    `INSERT INTO teams (id, organization_id, slug, name) VALUES ($1, $2, 'pod', 'Pod')`,
    [team, ORG_A],
  );
  for (const [id, slug] of [
    [WS_1, 'acme'],
    [WS_2, 'borealis'],
  ] as const) {
    await admin.query(
      `INSERT INTO workspaces (id, organization_id, team_id, slug, name)
       VALUES ($1, $2, $3, $4, $4)`,
      [id, ORG_A, team, slug],
    );
  }

  await admin.query(`INSERT INTO plans (id, key, name) VALUES ($1, 'starter', 'Starter')`, [
    PLAN_STARTER,
  ]);
  await admin.query(`INSERT INTO plans (id, key, name) VALUES ($1, 'scale', 'Scale')`, [
    PLAN_SCALE,
  ]);
  await admin.query(
    `INSERT INTO plan_features (id, plan_id, capability_key, enabled, limit_value, is_unlimited)
     VALUES ($1, $2, 'social.scheduling', true, 10, false),
            ($3, $2, 'social.analytics', true, NULL, true),
            ($4, $5, 'social.scheduling', true, NULL, true)`,
    [randomUUID(), PLAN_STARTER, randomUUID(), randomUUID(), PLAN_SCALE],
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

async function subscribe(organizationId: string, planId: string, status = 'active') {
  await admin.query(
    `INSERT INTO subscriptions
       (id, organization_id, plan_id, status, current_period_start, current_period_end)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), organizationId, planId, status, PERIOD_START, PERIOD_END],
  );
}

describe('the catalogue is the single source of truth for capability keys', () => {
  /**
   * `plan_features.capability_key` is deliberately not a foreign key — the catalogue is code.
   * This is the check that keeps the two from drifting: a plan granting a capability no code
   * path consults is a silent no-op, and a typo'd key is a silent denial.
   */
  it('every stored plan feature names a capability the catalogue declares', async () => {
    const stored = await admin.query<{ capability_key: string }>(
      'SELECT DISTINCT capability_key FROM plan_features',
    );
    expect(unknownCapabilityKeys(stored.rows.map((r) => r.capability_key))).toEqual([]);
  });

  it('every stored override names one too', async () => {
    await inTenant(ORG_A, async (c) =>
      createOverrideRepository(c).upsert({
        organizationId: ORG_A,
        workspaceId: null,
        capabilityKey: 'ai.agents',
        enabled: true,
        isUnlimited: true,
        reason: 'enterprise deal',
        expiresAt: null,
        grantedBy: null,
      }),
    );
    const stored = await admin.query<{ capability_key: string }>(
      'SELECT DISTINCT capability_key FROM entitlement_overrides',
    );
    expect(unknownCapabilityKeys(stored.rows.map((r) => r.capability_key))).toEqual([]);
  });

  it('declares every capability the architecture names', () => {
    for (const key of [
      'social.accounts',
      'social.publishing',
      'marketing.campaigns',
      'ai.agents',
      'marketplace.selling',
      'marketplace.payouts',
    ]) {
      expect(capabilityKeys(), key).toContain(key);
    }
  });
});

describe('resolution against a real subscription', () => {
  it('reads the plan when one is live', async () => {
    await subscribe(ORG_A, PLAN_STARTER);
    const decision = await inTenant(ORG_A, async (c) =>
      serviceOn(c).resolve({
        organizationId: ORG_A,
        workspaceId: WS_1,
        capabilityKey: 'social.scheduling',
      }),
    );
    expect(decision.source).toBe('plan');
    expect(decision.limit).toEqual({ kind: 'bounded', value: 10 });
  });

  it('falls back to catalogue defaults with NO subscription — the free tier needs no row', async () => {
    const decision = await inTenant(ORG_A, async (c) =>
      serviceOn(c).resolve({
        organizationId: ORG_A,
        workspaceId: WS_1,
        capabilityKey: 'social.scheduling',
      }),
    );
    expect(decision.source).toBe('default');
    expect(decision.limit).toEqual({ kind: 'bounded', value: 30 });
  });

  /**
   * `past_due` still resolves. Cutting a customer off the moment a card fails turns a
   * payment retry into an outage; suspension is a dunning decision, taken by cancelling or
   * by writing a disabling override.
   */
  it('a past_due subscription still resolves to its plan', async () => {
    await subscribe(ORG_A, PLAN_STARTER, 'past_due');
    const decision = await inTenant(ORG_A, async (c) =>
      serviceOn(c).resolve({
        organizationId: ORG_A,
        workspaceId: WS_1,
        capabilityKey: 'social.scheduling',
      }),
    );
    expect(decision.source).toBe('plan');
  });

  it('a canceled subscription does not', async () => {
    await subscribe(ORG_A, PLAN_STARTER, 'canceled');
    const decision = await inTenant(ORG_A, async (c) =>
      serviceOn(c).resolve({
        organizationId: ORG_A,
        workspaceId: WS_1,
        capabilityKey: 'social.scheduling',
      }),
    );
    expect(decision.source).toBe('default');
  });

  it('one live subscription per organization is a database constraint', async () => {
    await subscribe(ORG_A, PLAN_STARTER);
    await expect(subscribe(ORG_A, PLAN_SCALE)).rejects.toThrow(/unique|duplicate/i);
  });
});

describe('consumption is atomic', () => {
  /**
   * THE RACE THIS DESIGN EXISTS TO LOSE SAFELY. Twenty concurrent callers against a limit of
   * ten: exactly ten succeed. A resolve followed by a separate increment would let most of
   * them through, because every one of them would read `used` before any of them wrote it.
   */
  it('twenty concurrent consumers against a limit of ten let exactly ten through', async () => {
    await subscribe(ORG_A, PLAN_STARTER);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        inTenant(ORG_A, async (c) =>
          serviceOn(c).consume({
            organizationId: ORG_A,
            workspaceId: WS_1,
            capabilityKey: 'social.scheduling',
          }),
        ),
      ),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed)).toHaveLength(10);

    const counter = await admin.query<{ used: string }>(
      'SELECT used FROM entitlement_usage WHERE organization_id = $1',
      [ORG_A],
    );
    expect(Number(counter.rows[0]?.used)).toBe(10);
  });

  it('the usage records sum to the counter, so a disputed bill is answerable', async () => {
    await subscribe(ORG_A, PLAN_STARTER);
    for (let i = 0; i < 4; i++) {
      await inTenant(ORG_A, async (c) =>
        serviceOn(c).consume({
          organizationId: ORG_A,
          workspaceId: WS_1,
          capabilityKey: 'social.scheduling',
          quantity: 2,
        }),
      );
    }
    const counter = await admin.query<{ used: string }>(
      'SELECT used FROM entitlement_usage WHERE organization_id = $1',
      [ORG_A],
    );
    const records = await admin.query<{ total: string }>(
      'SELECT COALESCE(SUM(quantity), 0) AS total FROM usage_records WHERE organization_id = $1',
      [ORG_A],
    );
    expect(Number(records.rows[0]?.total)).toBe(Number(counter.rows[0]?.used));
    expect(Number(counter.rows[0]?.used)).toBe(8);
  });

  it('a rolled-back transaction consumes nothing', async () => {
    await subscribe(ORG_A, PLAN_STARTER);
    await expect(
      inTenant(ORG_A, async (c) => {
        await serviceOn(c).consume({
          organizationId: ORG_A,
          workspaceId: WS_1,
          capabilityKey: 'social.scheduling',
        });
        throw new Error('the gated write failed');
      }),
    ).rejects.toThrow(/gated write failed/);

    const counter = await admin.query(
      'SELECT 1 FROM entitlement_usage WHERE organization_id = $1',
      [ORG_A],
    );
    expect(counter.rowCount).toBe(0);
  });
});

describe('what consumption declines to count', () => {
  it('an unlimited grant never opens a bounded refusal', async () => {
    await subscribe(ORG_A, PLAN_SCALE);
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        inTenant(ORG_A, async (c) =>
          serviceOn(c).consume({
            organizationId: ORG_A,
            workspaceId: WS_1,
            capabilityKey: 'social.scheduling',
          }),
        ),
      ),
    );
    expect(results.every((r) => r.allowed)).toBe(true);
  });

  it('refuses without opening a counter when the capability is off entirely', async () => {
    const verdict = await inTenant(ORG_A, async (c) =>
      serviceOn(c).consume({
        organizationId: ORG_A,
        workspaceId: WS_1,
        capabilityKey: 'marketing.campaigns',
      }),
    );
    expect(verdict).toMatchObject({ allowed: false, reason: 'not_entitled' });
    expect((await admin.query('SELECT 1 FROM entitlement_usage')).rowCount).toBe(0);
  });

  /** A gauge is HELD, not consumed: there is nothing to increment and no period to reset. */
  it('a gauge is checked against the caller-supplied count and writes no counter', async () => {
    const overLimit = await inTenant(ORG_A, async (c) =>
      serviceOn(c).consume({
        organizationId: ORG_A,
        workspaceId: WS_1,
        capabilityKey: 'social.accounts',
        currentCount: 2,
      }),
    );
    expect(overLimit).toMatchObject({ allowed: false, reason: 'limit_reached' });

    const underLimit = await inTenant(ORG_A, async (c) =>
      serviceOn(c).consume({
        organizationId: ORG_A,
        workspaceId: WS_1,
        capabilityKey: 'social.accounts',
        currentCount: 1,
      }),
    );
    expect(underLimit.allowed).toBe(true);
    expect((await admin.query('SELECT 1 FROM entitlement_usage')).rowCount).toBe(0);
  });
});
