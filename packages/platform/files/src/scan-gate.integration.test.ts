/**
 * The scan gate: a file is not usable until it is scanned clean.
 *
 * 10-security-architecture.md §3 requires an "async malware scan [that] gates scan_status before a file
 * is usable". Two things are tested here and they are different: that the gate holds for every
 * non-clean state, and that the application role cannot write the verdict that opens it. The second is
 * the one that would otherwise make the first decorative.
 */

import { stopSharedCluster } from '@growth-os/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildFileFixture, type FileFixture, NOW, PNG } from './__testing__/file-fixture.js';
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

describe('a file is not usable until it is scanned clean', () => {
  it('refuses a download for a ready but unscanned file', async () => {
    const { fileId } = await fx.upload(PNG);
    // THE gate from 10 §3. Ready means the bytes arrived; clean means they are safe, and a download
    // needs both.
    await expect(fx.inTenant((c) => fx.service.requestDownload(c, fileId))).rejects.toThrow(
      /No usable file/,
    );
  });

  it('hands out a short-lived attachment URL once the scan is clean', async () => {
    const { fileId } = await fx.upload(PNG);
    await scanOnce(
      fx.scanTransactor(),
      { scan: async () => ({ verdict: 'clean' }) },
      {
        now: () => NOW,
      },
    );

    const download = await fx.inTenant((c) => fx.service.requestDownload(c, fileId));
    expect(download.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    // Attachment, never inline: 10 §3 forbids rendering user-supplied content inline, and the port
    // does not offer the choice.
    expect(download.url).toContain('disposition=attachment');
    expect(download.url).toContain('filename=photo.png');
  });

  it('refuses a download for an infected file, and says nothing about why', async () => {
    const { fileId } = await fx.upload(PNG);
    await scanOnce(
      fx.scanTransactor(),
      { scan: async () => ({ verdict: 'infected', detail: 'Eicar-Test-Signature' }) },
      { now: () => NOW },
    );
    // One answer for absent, another tenant's, unfinalised and infected. Distinguishing them would
    // confirm an upload the caller should not know about.
    await expect(fx.inTenant((c) => fx.service.requestDownload(c, fileId))).rejects.toThrow(
      /No usable file/,
    );
    expect((await fx.rowOf(fileId))?.status).toBe('rejected');
  });

  it('refuses a download for a file whose scan failed', async () => {
    const { fileId } = await fx.upload(PNG);
    await scanOnce(fx.scanTransactor(), {
      scan() {
        return Promise.reject(new Error('engine unreachable'));
      },
    });
    // A throwing engine is `failed`, never `clean`. Treating it as a pass would serve unscanned files
    // precisely when the scanner was broken.
    expect((await fx.rowOf(fileId))?.scan_status).toBe('failed');
    await expect(fx.inTenant((c) => fx.service.requestDownload(c, fileId))).rejects.toThrow(
      /No usable file/,
    );
  });
});

describe('the application cannot write a scan verdict', () => {
  it('refuses an UPDATE of scan_status', async () => {
    const { fileId } = await fx.upload(PNG);
    // Without the column grant, a session could mark its own upload clean and have it served — the
    // control from 10 §3 defeated by one statement RLS would allow, because the row passes the tenant
    // predicate.
    await expect(
      fx.inTenant((c) => c.query(`UPDATE files SET scan_status = 'clean' WHERE id = $1`, [fileId])),
    ).rejects.toThrow(/permission denied/);
  });

  it('refuses an UPDATE of scanned_at or scan_detail', async () => {
    const { fileId } = await fx.upload(PNG);
    for (const column of ['scanned_at = now()', `scan_detail = 'fine'`]) {
      await expect(
        fx.inTenant((c) => c.query(`UPDATE files SET ${column} WHERE id = $1`, [fileId])),
        column,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('still allows the updates finalisation needs', async () => {
    // The grant is a column list, so it has to be checked in both directions: withholding too much
    // would break the feature as surely as granting too much would break the control.
    const { fileId } = await fx.upload(PNG);
    await expect(
      fx.inTenant((c) =>
        c.query(`UPDATE files SET status = 'deleted', deleted_at = now() WHERE id = $1`, [fileId]),
      ),
    ).resolves.toBeDefined();
  });
});
