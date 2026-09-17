/**
 * The audit log against real PostgreSQL.
 *
 * Everything asserted here is a property OF THE DATABASE and cannot be established with a
 * mock: the append-only grants, row-level security on the parent AND on each partition, the
 * per-organization serialization that keeps concurrent writers from forking the chain, and
 * the transactional coupling between a business change and the record of it.
 */

import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from '@growth-os/testing';
import { Client, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEventInput } from './event.js';
import { createAuditReader } from './reader.js';
import { createAuditRecorder } from './recorder.js';

let db: TestDatabase;
let admin: Client;

const ORG_A = '01900000-0000-7000-8000-0000000a0001';
const ORG_B = '01900000-0000-7000-8000-0000000b0001';
const WS_1 = '01900000-0000-7000-8000-0000000a1001';
const WS_2 = '01900000-0000-7000-8000-0000000a1002';
const USER = '01900000-0000-7000-8000-0000000a2001';

/** Opens a tenant-scoped transaction by hand: this package must not depend on modules. */
async function inTenant<T>(
  organizationId: string,
  body: (client: PoolClient) => Promise<T>,
  options: { workspaceIds?: readonly string[]; scope?: 'set' | 'all'; commit?: boolean } = {},
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
    await client.query(options.commit === false ? 'ROLLBACK' : 'COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function entry(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    organizationId: ORG_A,
    actor: { type: 'user', userId: USER },
    action: 'organization.api_key.created',
    resourceType: 'api_key',
    resourceId: 'key-1',
    result: 'succeeded',
    ...overrides,
  };
}

async function record(input: AuditEventInput, organizationId = input.organizationId) {
  return await inTenant(organizationId, async (c) => await createAuditRecorder(c).record(input));
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

describe('the table is append-only, structurally', () => {
  /**
   * The grant, not a trigger and not a convention. 05 §9 requires the application role to
   * hold INSERT and SELECT and nothing else — and migration 0001's default privileges would
   * otherwise have handed it UPDATE and DELETE here.
   */
  it('the application role holds INSERT and SELECT and nothing else', async () => {
    const r = await admin.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'growth_os_app' AND table_name = 'audit_events'`,
    );
    expect(r.rows.map((x) => x.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
  });

  it('refuses an UPDATE outright', async () => {
    await record(entry());
    await expect(
      inTenant(ORG_A, async (c) => await c.query(`UPDATE audit_events SET action = 'x'`)),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses a DELETE outright', async () => {
    await record(entry());
    await expect(
      inTenant(ORG_A, async (c) => await c.query('DELETE FROM audit_events')),
    ).rejects.toThrow(/permission denied/i);
  });

  it('will not let the chain head be deleted, which would restart a chain', async () => {
    await record(entry());
    await expect(
      inTenant(ORG_A, async (c) => await c.query('DELETE FROM audit_chain_heads')),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('partitions are not an unpoliced back door', () => {
  /**
   * A partition is a table in its own right: policies on the parent govern access THROUGH
   * the parent, and ALTER DEFAULT PRIVILEGES would grant the application full DML on each
   * new monthly partition. Left alone, a scheduled job would quietly create a readable,
   * writable, unpoliced copy of the audit log every month.
   */
  it('every partition carries the policy and the restricted grants', async () => {
    const partitions = await admin.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'audit_events'`,
    );
    expect(partitions.rowCount).toBeGreaterThan(0);

    for (const { relname } of partitions.rows) {
      const rls = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        'SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1',
        [relname],
      );
      expect(rls.rows[0]?.relrowsecurity, relname).toBe(true);
      expect(rls.rows[0]?.relforcerowsecurity, relname).toBe(true);

      const grants = await admin.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'growth_os_app' AND table_name = $1`,
        [relname],
      );
      expect(grants.rows.map((g) => g.privilege_type).sort(), relname).toEqual([
        'INSERT',
        'SELECT',
      ]);
    }
  });

  it('naming a partition directly does not escape tenant isolation', async () => {
    await record(entry());
    const partition = await admin.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'audit_events' LIMIT 1`,
    );
    const name = partition.rows[0]?.relname ?? '';

    // ORG_B asking the partition directly for ORG_A's events.
    const rows = await inTenant(ORG_B, async (c) => {
      const r = await c.query(`SELECT id FROM ${name}`);
      return r.rowCount;
    });
    expect(rows).toBe(0);
  });
});

describe('tenant and workspace isolation', () => {
  it('one organization cannot read another’s events', async () => {
    await record(entry({ organizationId: ORG_A }));
    await record(entry({ organizationId: ORG_B, resourceId: 'key-b' }), ORG_B);

    const seen = await inTenant(
      ORG_B,
      async (c) =>
        await createAuditReader(c).list({
          organizationId: ORG_B,
        }),
    );
    expect(seen.events).toHaveLength(1);
    expect(seen.events[0]?.resourceId).toBe('key-b');

    // And asking for the other tenant's id explicitly returns nothing: the policy, not the
    // parameter, is what decides.
    const cross = await inTenant(
      ORG_B,
      async (c) =>
        await createAuditReader(c).list({
          organizationId: ORG_A,
        }),
    );
    expect(cross.events).toHaveLength(0);
  });

  /**
   * A workspace-tagged event is subject to the same accessible-set boundary every other
   * workspace-scoped table carries since 0007. Without it, a session holding audit_log:read
   * would read events about clients it cannot otherwise see.
   */
  it('a session restricted to one workspace sees only that workspace’s events', async () => {
    await record(entry({ workspaceId: WS_1, resourceId: 'in-scope' }));
    await record(entry({ workspaceId: WS_2, resourceId: 'out-of-scope' }));
    await record(entry({ resourceId: 'org-level' }));

    const seen = await inTenant(
      ORG_A,
      async (c) => await createAuditReader(c).list({ organizationId: ORG_A }),
      { workspaceIds: [WS_1], scope: 'set' },
    );
    const ids = seen.events.map((e) => e.resourceId).sort();
    // The organization-level event stays visible: it is not about a workspace at all, and
    // audit_log:read is an organization-scoped permission.
    expect(ids).toEqual(['in-scope', 'org-level']);
  });

  it('a session with an empty workspace set sees no workspace-tagged events at all', async () => {
    await record(entry({ workspaceId: WS_1 }));
    const seen = await inTenant(
      ORG_A,
      async (c) => await createAuditReader(c).list({ organizationId: ORG_A }),
      { workspaceIds: [], scope: 'set' },
    );
    expect(seen.events).toHaveLength(0);
  });
});
