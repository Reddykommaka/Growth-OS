/**
 * The fixture the file suites share.
 *
 * Extracted because the setup is substantial — two organizations, two workspaces, a user, a worker pool
 * and a store — and duplicating it across suites would mean two copies drifting apart on the detail
 * that matters most: which workspaces a session can reach. `upload` takes the accessible set
 * explicitly for exactly that reason.
 */

import { randomUUID } from 'node:crypto';
import { acquireTestDatabase, setTenantContext, type TestDatabase } from '@growth-os/testing';
import { Client, Pool, type PoolClient } from 'pg';
import { createMemoryStore, type MemoryStore } from '../memory-store.js';
import type { ScanTransactor } from '../scan.js';
import { createFileService, type FileService } from '../service.js';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const ORG_OTHER = '22222222-2222-4222-8222-222222222222';
export const USER = '33333333-3333-4333-8333-333333333333';
export const WS = '55555555-5555-4555-8555-555555555555';
export const WS_OTHER = '66666666-6666-4666-8666-666666666666';

export const NOW = new Date('2026-09-28T12:00:00Z');

/** A minimal but real PNG: the signature plus filler, so sniffing has something to identify. */
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(120, 7),
]);

export interface FileRow {
  status: string;
  scan_status: string;
  mime_type: string | null;
  size_bytes: string | null;
  checksum: string | null;
  purpose: string;
}

export interface FileFixture {
  readonly db: TestDatabase;
  /** Superuser connection, for seeding and for asserting on rows a policy would hide. */
  readonly admin: Client;
  /** The worker's pool, for the scanner. */
  readonly workerPool: Pool;
  readonly store: MemoryStore;
  readonly service: FileService;
  /** Runs a body in a committed tenant transaction, as an application service does. */
  inTenant<T>(
    fn: (client: PoolClient) => Promise<T>,
    organizationId?: string,
    workspaceIds?: readonly string[],
  ): Promise<T>;
  /** Reserves, uploads to the store, and finalises. The whole client journey. */
  upload(
    bytes: Buffer,
    over?: Partial<Parameters<FileService['requestUpload']>[1]>,
    /**
     * The session's accessible set for BOTH legs.
     *
     * Explicit because a file in a workspace the session cannot reach is invisible to it — so a helper
     * that hard-coded one set could reserve a row for another workspace and then fail to finalise it,
     * which is correct behaviour and a useless fixture.
     */
    workspaceIds?: readonly string[],
  ): Promise<{ fileId: string; storageKey: string }>;
  rowOf(fileId: string): Promise<FileRow | undefined>;
  scanTransactor(): ScanTransactor;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Two organizations, two workspaces in one of them, and a user.
 *
 * Real rows, because `files` has foreign keys to all three: a fixture that skipped them would be
 * testing a schema we do not deploy. The second workspace exists so "outside the accessible set" is a
 * real state rather than a hypothetical one.
 */
async function seed(admin: Client): Promise<void> {
  for (const [id, name] of [
    [ORG, 'Acme'],
    [ORG_OTHER, 'Rival'],
  ] as const) {
    await admin.query(
      `INSERT INTO organizations (id, name, slug, kind) VALUES ($1, $2, $3, 'agency')`,
      [id, name, name.toLowerCase()],
    );
  }
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, 'a@example.com')`, [USER]);
  for (const [id, org, slug] of [
    [WS, ORG, 'acme-main'],
    [WS_OTHER, ORG, 'acme-other'],
  ] as const) {
    await admin.query(
      'INSERT INTO workspaces (id, organization_id, name, slug) VALUES ($1, $2, $3, $4)',
      [id, org, slug, slug],
    );
  }
}

/** A transactor over the worker's pool, as apps/worker will supply to the scanner. */
function scanTransactorOn(pool: Pool): ScanTransactor {
  return {
    async run(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client as unknown as Parameters<typeof fn>[0]);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export async function buildFileFixture(): Promise<FileFixture> {
  const db = await acquireTestDatabase();
  const admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();
  const workerPool = new Pool({ connectionString: db.relayUrl, max: 3 });
  const store = createMemoryStore(() => NOW);
  const service = createFileService({
    storage: store,
    clock: { now: () => NOW },
    ids: { next: () => randomUUID() },
  });

  await seed(admin);

  async function inTenant<T>(
    fn: (client: PoolClient) => Promise<T>,
    organizationId = ORG,
    workspaceIds: readonly string[] = [WS],
  ): Promise<T> {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await setTenantContext(client, { organizationId, userId: USER, workspaceIds });
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    db,
    admin,
    workerPool,
    store,
    service,
    inTenant,

    async upload(bytes, over = {}, workspaceIds = [WS]) {
      const reserved = await inTenant(
        (c) =>
          service.requestUpload(c, {
            organizationId: ORG,
            workspaceId: WS,
            uploadedBy: USER,
            purpose: 'media',
            declaredMime: 'image/png',
            originalName: 'photo.png',
            sizeBytes: bytes.length,
            ...over,
          }),
        ORG,
        workspaceIds,
      );
      store.put(reserved.storageKey, bytes);
      const result = await inTenant(
        (c) => service.finalizeUpload(c, reserved.fileId),
        ORG,
        workspaceIds,
      );
      if (result.outcome !== 'ready') throw new Error(`upload was rejected: ${result.reason}`);
      return { fileId: reserved.fileId, storageKey: reserved.storageKey };
    },

    async rowOf(fileId) {
      const r = await admin.query<FileRow>(
        'SELECT status, scan_status, mime_type, size_bytes, checksum, purpose FROM files WHERE id = $1',
        [fileId],
      );
      return r.rows[0];
    },

    scanTransactor: () => scanTransactorOn(workerPool),

    async reset() {
      await admin.query('DELETE FROM files');
    },

    async close() {
      await workerPool.end();
      await admin.end();
      await db.close();
    },
  };
}
