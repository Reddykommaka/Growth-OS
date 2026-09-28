/**
 * An in-memory `StoragePort`.
 *
 * Not a mock of the protocol — an implementation of it. The upload protocol's security properties
 * (server-generated keys, magic-byte verification, the ready-and-clean gate) are all properties of
 * this package's logic rather than of S3, so they can and should be tested without credentials, a
 * bucket or a network. What this store cannot test is the S3 adapter's signing, which is why that
 * adapter is a separate package with its own tests against a real endpoint (ADR-0022).
 *
 * It lives in `src` rather than in a test file because the worker's local-development mode uses it
 * too: a developer with no bucket gets a working upload flow rather than a broken one.
 */
import { createHash } from 'node:crypto';
import type { PresignedDownload, PresignedUpload, StoragePort, StoredObject } from './ports.js';

export interface MemoryStore extends StoragePort {
  /** Simulates the client's PUT. Nothing in production calls this. */
  put(key: string, bytes: Buffer): void;
  readonly keys: () => readonly string[];
  /** Every URL this store has signed, so a test can assert what was granted and for how long. */
  readonly signed: readonly { kind: 'upload' | 'download'; key: string; expiresAt: Date }[];
}

export function createMemoryStore(now: () => Date = () => new Date()): MemoryStore {
  const objects = new Map<string, Buffer>();
  const signed: { kind: 'upload' | 'download'; key: string; expiresAt: Date }[] = [];

  const expiry = (seconds: number): Date => new Date(now().getTime() + seconds * 1000);

  return {
    put(key, bytes) {
      objects.set(key, bytes);
    },
    keys: () => [...objects.keys()],
    signed,

    presignUpload({ key, contentType, contentLength, expiresInSeconds }): Promise<PresignedUpload> {
      const expiresAt = expiry(expiresInSeconds);
      signed.push({ kind: 'upload', key, expiresAt });
      return Promise.resolve({
        url: `memory://upload/${encodeURIComponent(key)}`,
        method: 'PUT',
        // The headers a real signature would cover. Returned here too, so a test can assert that the
        // declared size and type are bound rather than advisory.
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(contentLength),
        },
        expiresAt,
      });
    },

    presignDownload({ key, expiresInSeconds, filename }): Promise<PresignedDownload> {
      const expiresAt = expiry(expiresInSeconds);
      signed.push({ kind: 'download', key, expiresAt });
      return Promise.resolve({
        // `attachment`, always. 10 §3 forbids rendering user-supplied content inline, and a port
        // whose default were `inline` would make that a per-caller decision.
        url:
          `memory://download/${encodeURIComponent(key)}` +
          `?disposition=attachment&filename=${encodeURIComponent(filename)}`,
        expiresAt,
      });
    },

    head(key): Promise<StoredObject | undefined> {
      const bytes = objects.get(key);
      if (bytes === undefined) return Promise.resolve(undefined);
      return Promise.resolve({
        sizeBytes: bytes.length,
        checksum: createHash('sha256').update(bytes).digest('hex'),
      });
    },

    readHead(key, count): Promise<Buffer | undefined> {
      const bytes = objects.get(key);
      return Promise.resolve(bytes === undefined ? undefined : bytes.subarray(0, count));
    },

    delete(key): Promise<void> {
      objects.delete(key);
      return Promise.resolve();
    },

    copy({ from, to }): Promise<void> {
      const bytes = objects.get(from);
      if (bytes !== undefined) objects.set(to, bytes);
      return Promise.resolve();
    },
  };
}
