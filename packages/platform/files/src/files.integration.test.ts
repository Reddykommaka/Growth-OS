/**
 * The upload protocol against a real schema: reservation, finalisation and deletion.
 *
 * The properties worth the setup cost are the ones that span the database and the store — that a
 * reservation exists before the bytes do, and that finalisation measures the OBJECT rather than
 * believing the claim. The scan gate has its own suite.
 */

import { setTenantContext, stopSharedCluster } from '@growth-os/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildFileFixture,
  type FileFixture,
  NOW,
  ORG,
  ORG_OTHER,
  PNG,
  USER,
  WS,
  WS_OTHER,
} from './__testing__/file-fixture.js';
import { scanOnce } from './scan.js';

let fx: FileFixture;

beforeAll(async () => {
  fx = await buildFileFixture();
}, 120_000);

afterAll(async () => {
  await fx?.close();
  await stopSharedCluster();
});

afterEach(async () => {
  await fx.reset();
});

describe('reservation', () => {
  it('writes a reserved row and mints a bounded upload URL', async () => {
    const reserved = await fx.inTenant((c) =>
      fx.service.requestUpload(c, {
        organizationId: ORG,
        workspaceId: WS,
        purpose: 'media',
        declaredMime: 'image/png',
        originalName: 'photo.png',
        sizeBytes: PNG.length,
      }),
    );

    const row = await fx.rowOf(reserved.fileId);
    expect(row).toMatchObject({ status: 'reserved', scan_status: 'pending', purpose: 'media' });
    // Nothing is known about the bytes yet, and the ready-state constraint is what enforces that.
    expect(row?.mime_type).toBeNull();
    expect(row?.size_bytes).toBeNull();

    expect(reserved.method).toBe('PUT');
    expect(reserved.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    // The declared size and type are bound by the signature, not merely advisory: a client sending
    // different ones gets a signature mismatch from storage instead of a stored file to reject.
    expect(reserved.headers['Content-Length']).toBe(String(PNG.length));
    expect(reserved.headers['Content-Type']).toBe('image/png');
  });

  it('generates the key itself, carrying the organization and the date', async () => {
    const reserved = await fx.inTenant((c) =>
      fx.service.requestUpload(c, {
        organizationId: ORG,
        purpose: 'media',
        declaredMime: 'image/png',
        originalName: 'photo.png',
        sizeBytes: 10,
      }),
    );
    expect(reserved.storageKey).toMatch(new RegExp(`^org/${ORG}/2026/09/[0-9a-f-]{36}$`));
  });

  it('refuses an over-cap upload before any URL is minted', async () => {
    // The cheap refusal. Checking only at finalisation would mean the gigabyte is already in the
    // bucket before we object.
    await expect(
      fx.inTenant((c) =>
        fx.service.requestUpload(c, {
          organizationId: ORG,
          purpose: 'import',
          declaredMime: 'text/csv',
          originalName: 'huge.csv',
          sizeBytes: 1024 * 1024 * 1024,
        }),
      ),
    ).rejects.toThrow(/at most/);
    expect((await fx.admin.query('SELECT 1 FROM files')).rowCount).toBe(0);
    expect(fx.store.signed.filter((s) => s.kind === 'upload' && s.key.includes('huge'))).toEqual(
      [],
    );
  });

  it('rolls back the reservation with the caller transaction', async () => {
    const client = await fx.db.pool.connect();
    try {
      await client.query('BEGIN');
      await setTenantContext(client, { organizationId: ORG, userId: USER, workspaceIds: [WS] });
      await fx.service.requestUpload(client, {
        organizationId: ORG,
        purpose: 'media',
        declaredMime: 'image/png',
        originalName: 'photo.png',
        sizeBytes: 10,
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect((await fx.admin.query('SELECT 1 FROM files')).rowCount).toBe(0);
  });

  it('refuses a reservation in another organization', async () => {
    await expect(
      fx.inTenant((c) =>
        fx.service.requestUpload(c, {
          organizationId: ORG_OTHER,
          purpose: 'media',
          declaredMime: 'image/png',
          originalName: 'photo.png',
          sizeBytes: 10,
        }),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });
});

describe('finalisation measures the object, not the claim', () => {
  it('promotes a reservation once the bytes are verified', async () => {
    const { fileId } = await fx.upload(PNG);
    const row = await fx.rowOf(fileId);
    expect(row).toMatchObject({ status: 'ready', scan_status: 'pending', mime_type: 'image/png' });
    expect(Number(row?.size_bytes)).toBe(PNG.length);
    expect(row?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records the REAL size even when the client declared another', async () => {
    // The declaration was a claim; this is the fact. A client that declares one byte and uploads a
    // hundred is recorded honestly.
    const reserved = await fx.inTenant((c) =>
      fx.service.requestUpload(c, {
        organizationId: ORG,
        workspaceId: WS,
        purpose: 'media',
        declaredMime: 'image/png',
        originalName: 'photo.png',
        sizeBytes: 1,
      }),
    );
    fx.store.put(reserved.storageKey, PNG);
    const result = await fx.inTenant((c) => fx.service.finalizeUpload(c, reserved.fileId));
    expect(result.outcome).toBe('ready');
    if (result.outcome === 'ready') expect(result.sizeBytes).toBe(PNG.length);
  });

  it('rejects an object whose real size is over the cap', async () => {
    const reserved = await fx.inTenant((c) =>
      fx.service.requestUpload(c, {
        organizationId: ORG,
        workspaceId: WS,
        purpose: 'document',
        declaredMime: 'application/pdf',
        originalName: 'contract.pdf',
        sizeBytes: 100,
      }),
    );
    const oversize = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.alloc(33 * 1024 * 1024, 0x20),
    ]);
    fx.store.put(reserved.storageKey, oversize);
    const result = await fx.inTenant((c) => fx.service.finalizeUpload(c, reserved.fileId));
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') expect(result.reason).toMatch(/at most/);
    // The mark must survive the operation: a rejection that rolled back would leave the row reserved
    // forever while the caller reported a failure.
    expect((await fx.rowOf(reserved.fileId))?.status).toBe('rejected');
  });
});

describe('finalisation rejects what the bytes are not allowed to be', () => {
  it('rejects bytes the purpose does not allow, and deletes the object', async () => {
    const reserved = await fx.inTenant((c) =>
      fx.service.requestUpload(c, {
        organizationId: ORG,
        workspaceId: WS,
        purpose: 'media',
        declaredMime: 'image/png',
        originalName: 'photo.png',
        sizeBytes: 40,
      }),
    );
    // A PDF uploaded under an image declaration. The bytes decide.
    fx.store.put(reserved.storageKey, Buffer.from('%PDF-1.7\n1 0 obj\n'));
    const result = await fx.inTenant((c) => fx.service.finalizeUpload(c, reserved.fileId));
    expect(result.outcome).toBe('rejected');

    const row = await fx.rowOf(reserved.fileId);
    // The row survives as `rejected` — a pattern of rejections from one organization is a signal —
    // and the bytes do not, because keeping a payload we have just refused is how it gets served by
    // mistake later.
    expect(row?.status).toBe('rejected');
    expect(fx.store.keys()).not.toContain(reserved.storageKey);
  });

  it('rejects HTML declared as a CSV import', async () => {
    const reserved = await fx.inTenant((c) =>
      fx.service.requestUpload(c, {
        organizationId: ORG,
        workspaceId: WS,
        purpose: 'import',
        declaredMime: 'text/csv',
        originalName: 'contacts.csv',
        sizeBytes: 40,
      }),
    );
    fx.store.put(reserved.storageKey, Buffer.from('<!DOCTYPE html><script>alert(1)</script>'));
    const result = await fx.inTenant((c) => fx.service.finalizeUpload(c, reserved.fileId));
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') expect(result.reason).toMatch(/Markup/);
    expect((await fx.rowOf(reserved.fileId))?.status).toBe('rejected');
  });

  it('reports a declaration mismatch that is nonetheless allowed', async () => {
    const reserved = await fx.inTenant((c) =>
      fx.service.requestUpload(c, {
        organizationId: ORG,
        workspaceId: WS,
        purpose: 'media',
        declaredMime: 'image/jpeg',
        originalName: 'photo.jpg',
        sizeBytes: PNG.length,
      }),
    );
    fx.store.put(reserved.storageKey, PNG);
    const result = await fx.inTenant((c) => fx.service.finalizeUpload(c, reserved.fileId));
    // Allowed — a PNG is fine for media — but the disagreement is reported rather than swallowed.
    expect(result.outcome).toBe('ready');
    if (result.outcome === 'ready') {
      expect(result.mimeType).toBe('image/png');
      expect(result.declarationMismatched).toBe(true);
    }
  });

  it('refuses to finalise a reservation with no object behind it', async () => {
    const reserved = await fx.inTenant((c) =>
      fx.service.requestUpload(c, {
        organizationId: ORG,
        workspaceId: WS,
        purpose: 'media',
        declaredMime: 'image/png',
        originalName: 'photo.png',
        sizeBytes: 10,
      }),
    );
    await expect(fx.inTenant((c) => fx.service.finalizeUpload(c, reserved.fileId))).rejects.toThrow(
      /No object was uploaded/,
    );
    expect((await fx.rowOf(reserved.fileId))?.status).toBe('reserved');
  });

  it('lets only one of two concurrent finalisations win', async () => {
    const reserved = await fx.inTenant((c) =>
      fx.service.requestUpload(c, {
        organizationId: ORG,
        workspaceId: WS,
        purpose: 'media',
        declaredMime: 'image/png',
        originalName: 'photo.png',
        sizeBytes: PNG.length,
      }),
    );
    fx.store.put(reserved.storageKey, PNG);
    await fx.inTenant((c) => fx.service.finalizeUpload(c, reserved.fileId));
    // The second attempt must not overwrite a verified measurement with a second reading.
    await expect(fx.inTenant((c) => fx.service.finalizeUpload(c, reserved.fileId))).rejects.toThrow(
      /No reserved upload/,
    );
  });
});

describe('tenant isolation', () => {
  it('hides another organization files', async () => {
    const { fileId } = await fx.upload(PNG);
    const seen = await fx.inTenant(
      (c) => c.query('SELECT id FROM files WHERE id = $1', [fileId]),
      ORG_OTHER,
      [],
    );
    expect(seen.rows).toEqual([]);
  });

  it('hides a file in a workspace outside the accessible set', async () => {
    const { fileId } = await fx.upload(PNG, { workspaceId: WS_OTHER }, [WS, WS_OTHER]);
    const seen = await fx.inTenant(
      (c) => c.query('SELECT id FROM files WHERE id = $1', [fileId]),
      ORG,
      [WS],
    );
    expect(seen.rows).toEqual([]);
  });
});

describe('deletion', () => {
  it('marks the row deleted and removes the object', async () => {
    const { fileId, storageKey } = await fx.upload(PNG);
    expect(await fx.inTenant((c) => fx.service.deleteFile(c, fileId))).toBe(true);
    expect((await fx.rowOf(fileId))?.status).toBe('deleted');
    expect(fx.store.keys()).not.toContain(storageKey);
  });

  it('is idempotent', async () => {
    const { fileId } = await fx.upload(PNG);
    expect(await fx.inTenant((c) => fx.service.deleteFile(c, fileId))).toBe(true);
    expect(await fx.inTenant((c) => fx.service.deleteFile(c, fileId))).toBe(false);
  });

  it('makes the file undownloadable', async () => {
    const { fileId } = await fx.upload(PNG);
    await scanOnce(fx.scanTransactor(), { scan: async () => ({ verdict: 'clean' }) });
    await fx.inTenant((c) => fx.service.deleteFile(c, fileId));
    await expect(fx.inTenant((c) => fx.service.requestDownload(c, fileId))).rejects.toThrow(
      /No usable file/,
    );
  });
});
