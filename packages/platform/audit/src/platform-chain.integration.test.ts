/**
 * The platform chain — events that precede any tenant.
 *
 * A failed sign-in against an address belonging to nobody has no organization. Under
 * migration 0011 alone it could not be written at all: the policy compares organization_id to
 * a NULL tenant context and refuses. Migration 0012 permits exactly one thing more, and this
 * suite is about the BOUNDS of that permission, not the feature.
 */

import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from '@growth-os/testing';
import { Client, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuditSink } from './adapter.js';
import { genesisHash } from './canonical.js';
import { createAuditReader } from './reader.js';
import { PLATFORM_ORGANIZATION_ID } from './sink.js';
import { verifyChain } from './verify.js';

let db: TestDatabase;
let admin: Client;

const TENANT = '01900000-0000-7000-8000-0000000f0001';
const OTHER_TENANT = '01900000-0000-7000-8000-0000000f0002';

/** An untenanted transaction: no app.organization_id at all, as sign-in runs. */
async function untenanted<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
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

async function inTenant<T>(
  organizationId: string,
  body: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.organization_id', organizationId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_ids', '{}']);
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

beforeAll(async () => {
  db = await acquireTestDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();
}, 180_000);

afterAll(async () => {
  await admin.end();
  await db.close();
  await stopSharedCluster();
});

beforeEach(async () => {
  await admin.query('DELETE FROM audit_events');
  await admin.query('DELETE FROM audit_chain_heads');
});

describe('a pre-tenant security event is recorded, not dropped', () => {
  it('an untenanted failed sign-in lands on the platform chain', async () => {
    await untenanted(async (c) =>
      createAuditSink(c).record({
        // No organizationId at all — the shape a sign-in against an unknown address has.
        actor: { type: 'system' },
        action: 'identity.signin.failed',
        resourceType: 'user',
        resourceId: 'nobody@example.test',
        result: 'failed',
        ip: '203.0.113.9',
      }),
    );

    const row = await admin.query<{ organization_id: string; action: string; result: string }>(
      'SELECT organization_id, action, result FROM audit_events',
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]?.organization_id).toBe(PLATFORM_ORGANIZATION_ID);
    expect(row.rows[0]?.result).toBe('failed');
  });

  it('the platform chain is a real chain: gapless, linked and verifiable', async () => {
    for (let i = 0; i < 4; i++) {
      await untenanted(async (c) =>
        createAuditSink(c).record({
          actor: { type: 'system' },
          action: 'identity.signin.failed',
          resourceType: 'user',
          resourceId: `attempt-${i}`,
          result: 'failed',
        }),
      );
    }

    const events = await inTenant(
      PLATFORM_ORGANIZATION_ID,
      async (c) => await createAuditReader(c).chainSlice(PLATFORM_ORGANIZATION_ID, 1, 100),
    );
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(events[0]?.prevHash).toEqual(genesisHash(PLATFORM_ORGANIZATION_ID));
    expect(verifyChain(PLATFORM_ORGANIZATION_ID, events)).toMatchObject({ valid: true });
  });

  it('concurrent untenanted writers do not fork it', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        untenanted(async (c) =>
          createAuditSink(c).record({
            actor: { type: 'system' },
            action: 'identity.signin.failed',
            resourceType: 'user',
            resourceId: `race-${i}`,
            result: 'failed',
          }),
        ),
      ),
    );
    const events = await inTenant(
      PLATFORM_ORGANIZATION_ID,
      async (c) => await createAuditReader(c).chainSlice(PLATFORM_ORGANIZATION_ID, 1, 100),
    );
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(verifyChain(PLATFORM_ORGANIZATION_ID, events)).toMatchObject({ valid: true });
  });
});

describe('the permission is bounded in both directions', () => {
  /**
   * THE WIDENING THAT MUST NOT HAVE HAPPENED. An untenanted transaction may write the
   * platform chain and NOTHING ELSE. If the added clause had been written as "no context ⇒
   * allow", every tenant's log would be writable from the untenanted path.
   */
  it('an untenanted writer cannot write any tenant’s events', async () => {
    await expect(
      untenanted(async (c) =>
        createAuditSink(c).record({
          organizationId: TENANT,
          actor: { type: 'system' },
          action: 'organization.member.role_changed',
          resourceType: 'member',
          resourceId: 'm-1',
          result: 'succeeded',
        }),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
    expect((await admin.query('SELECT 1 FROM audit_events')).rowCount).toBe(0);
  });

  it('a tenant session cannot write platform events', async () => {
    await expect(
      inTenant(TENANT, async (c) =>
        createAuditSink(c).record({
          organizationId: PLATFORM_ORGANIZATION_ID,
          actor: { type: 'system' },
          action: 'identity.signin.failed',
          resourceType: 'user',
          resourceId: 'spoofed',
          result: 'failed',
        }),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
    expect((await admin.query('SELECT 1 FROM audit_events')).rowCount).toBe(0);
  });

  /**
   * And the READ rule is untouched: platform events stay invisible to every tenant. One
   * tenant must never learn that an address it does not own failed to sign in.
   */
  it('no tenant session can read the platform chain', async () => {
    await untenanted(async (c) =>
      createAuditSink(c).record({
        actor: { type: 'system' },
        action: 'identity.signin.failed',
        resourceType: 'user',
        resourceId: 'private@example.test',
        result: 'failed',
      }),
    );

    for (const tenant of [TENANT, OTHER_TENANT]) {
      const seen = await inTenant(
        tenant,
        async (c) => await createAuditReader(c).list({ organizationId: PLATFORM_ORGANIZATION_ID }),
      );
      expect(seen.events, tenant).toHaveLength(0);
    }

    // The operator path — a session scoped to the reserved id — does see it.
    const operator = await inTenant(
      PLATFORM_ORGANIZATION_ID,
      async (c) => await createAuditReader(c).list({ organizationId: PLATFORM_ORGANIZATION_ID }),
    );
    expect(operator.events).toHaveLength(1);
  });

  it('a tenant’s own chain is unaffected and still starts at its own genesis', async () => {
    await untenanted(async (c) =>
      createAuditSink(c).record({
        actor: { type: 'system' },
        action: 'identity.signin.failed',
        resourceType: 'user',
        resourceId: 'x',
        result: 'failed',
      }),
    );
    await inTenant(TENANT, async (c) =>
      createAuditSink(c).record({
        organizationId: TENANT,
        actor: { type: 'system' },
        action: 'organization.member.role_changed',
        resourceType: 'member',
        resourceId: 'm-1',
        result: 'succeeded',
      }),
    );

    const events = await inTenant(
      TENANT,
      async (c) => await createAuditReader(c).chainSlice(TENANT, 1, 10),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.sequence).toBe(1);
    expect(events[0]?.prevHash).toEqual(genesisHash(TENANT));
  });
});
