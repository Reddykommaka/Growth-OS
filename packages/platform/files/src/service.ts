/**
 * The upload protocol.
 *
 * Three steps, and the reason there are three is that the server never sees the upload. The client
 * PUTs straight to storage (02 §"S3-compatible object storage"), so the only things the server can do
 * are decide in advance what it will permit, and afterwards verify what actually arrived.
 *
 *   1. `requestUpload`   reserves a row with a server-generated key and mints a presigned PUT.
 *   2. (the client uploads, and the server is not involved)
 *   3. `finalizeUpload`  asks STORAGE what is there, sniffs the real bytes, and either promotes the
 *                        row to `ready` or rejects it.
 *
 * Every check in step 3 is a re-check of something claimed in step 1, and that is deliberate: step 1
 * works on claims and step 3 works on facts. Doing only step 1 would trust the uploader about size
 * and type; doing only step 3 would let an unbounded upload into the bucket before anyone objected.
 *
 * A FILE IS NOT USABLE WHEN IT IS READY. It is usable when it is ready AND scanned clean
 * (10-security-architecture.md §3). Nothing here hands out a download URL for anything less, and the
 * scan verdict is a column this package's role cannot write.
 */
import { NotFoundError, ValidationError } from '@growth-os/errors';
import { declarationMismatches, SNIFF_BYTES, sniff } from './magic.js';
import {
  assertUploadAllowed,
  assertValidStorageKey,
  generateStorageKey,
  purposeAllows,
  type UploadRequest,
} from './policy.js';
import type { Clock, IdGenerator, Queryable, StoragePort } from './ports.js';

export interface FileDependencies {
  readonly storage: StoragePort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * How long an upload URL lives.
   *
   * Short, because a presigned PUT is a bearer write capability for one bucket path: anyone holding
   * the URL can write there until it expires. Long enough for a large upload on a slow connection is
   * the only reason it is not shorter.
   */
  readonly uploadUrlSeconds?: number;
  /** Download URLs are shorter-lived: they are shared, forwarded and pasted into tickets. */
  readonly downloadUrlSeconds?: number;
}

const DEFAULT_UPLOAD_SECONDS = 900;
const DEFAULT_DOWNLOAD_SECONDS = 300;

export interface ReserveInput extends UploadRequest {
  readonly organizationId: string;
  readonly workspaceId?: string | null | undefined;
  readonly uploadedBy?: string | null | undefined;
}

export interface ReservedUpload {
  readonly fileId: string;
  readonly storageKey: string;
  readonly url: string;
  readonly method: 'PUT';
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

/*
 * The id is supplied rather than RETURNINGed, for the same reason as `notifications` and
 * `outbound_messages`: the caller needs it before the row exists, and a RETURNING clause is governed
 * by the SELECT policy. Here it is also simply necessary — the storage key has to be in the INSERT
 * and the client has to be told the file id in the same response.
 */
const INSERT_RESERVED = `
  INSERT INTO files
    (id, organization_id, workspace_id, storage_key, declared_mime, original_name, purpose,
     uploaded_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

const SELECT_RESERVED = `
  SELECT id, organization_id, storage_key, declared_mime, original_name, purpose, status
    FROM files
   WHERE id = $1 AND status = 'reserved'`;

/*
 * Promotion is ONE conditional UPDATE, with `status = 'reserved'` in the predicate.
 *
 * Two clients finalising the same upload concurrently — a retry and the original, say — must not both
 * promote it. The second gets zero rows and is told the file is already final, rather than
 * overwriting a verified measurement with a second reading of the same object.
 */
const PROMOTE = `
  UPDATE files
     SET status = 'ready', mime_type = $2, size_bytes = $3, checksum = $4, finalized_at = $5
   WHERE id = $1 AND status = 'reserved'`;

const REJECT = `
  UPDATE files SET status = 'rejected' WHERE id = $1 AND status = 'reserved'`;

const SELECT_USABLE = `
  SELECT storage_key, original_name, mime_type, size_bytes
    FROM files
   WHERE id = $1 AND status = 'ready' AND scan_status = 'clean'`;

const SOFT_DELETE = `
  UPDATE files SET status = 'deleted', deleted_at = $2
   WHERE id = $1 AND status IN ('ready', 'rejected', 'reserved')`;

/**
 * The outcome of a finalisation.
 *
 * A REJECTION IS A RETURN VALUE, NOT AN EXCEPTION, and that is a correctness requirement rather than
 * a style preference. `finalizeUpload` runs inside the caller's transaction and marks the row
 * `rejected` — so throwing would roll that mark back along with everything else, and the row would
 * stay `reserved` forever while the caller reported a failure. The rejection has to survive the
 * operation that produced it.
 *
 * The two genuine exceptions remain exceptions: an unknown reservation and a missing object are
 * states with nothing to persist.
 */
export type FinalizeResult =
  | {
      readonly outcome: 'ready';
      readonly fileId: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
      readonly checksum: string;
      /** True when the sniffed type disagreed with the declaration but was still allowed. */
      readonly declarationMismatched: boolean;
    }
  | {
      readonly outcome: 'rejected';
      readonly fileId: string;
      /** Operator-facing. Safe to show the uploader: it names a policy, never a payload. */
      readonly reason: string;
    };

export interface FileService {
  requestUpload(client: Queryable, input: ReserveInput): Promise<ReservedUpload>;
  finalizeUpload(client: Queryable, fileId: string): Promise<FinalizeResult>;
  /** A short-lived download URL — only for a file that is ready AND scanned clean. */
  requestDownload(client: Queryable, fileId: string): Promise<{ url: string; expiresAt: Date }>;
  /** Marks the row deleted and removes the object. Order matters; see the implementation. */
  deleteFile(client: Queryable, fileId: string): Promise<boolean>;
}

interface ReservedRow {
  id: string;
  organization_id: string;
  storage_key: string;
  declared_mime: string;
  original_name: string;
  purpose: string;
  status: string;
}

export function createFileService(deps: FileDependencies): FileService {
  const uploadSeconds = deps.uploadUrlSeconds ?? DEFAULT_UPLOAD_SECONDS;
  const downloadSeconds = deps.downloadUrlSeconds ?? DEFAULT_DOWNLOAD_SECONDS;

  return {
    async requestUpload(client, input) {
      // Claims first: the cheap refusal. An oversized or unknown-purpose upload should cost one
      // round trip, not a gigabyte of bucket.
      const policy = assertUploadAllowed(input);
      const at = deps.clock.now();
      const fileId = deps.ids.next();
      const storageKey = generateStorageKey(input.organizationId, at);
      assertValidStorageKey(storageKey);

      await client.query(INSERT_RESERVED, [
        fileId,
        input.organizationId,
        input.workspaceId ?? null,
        storageKey,
        input.declaredMime,
        input.originalName,
        policy.purpose,
        input.uploadedBy ?? null,
      ]);

      /*
       * The row is written BEFORE the URL is minted, and inside the caller's transaction.
       *
       * A URL handed out without a row is a write capability for a bucket path nothing knows about:
       * the object would arrive, never be finalised, never be scanned and never be reaped. A row
       * without a URL is merely a reservation that expires.
       */
      const presigned = await deps.storage.presignUpload({
        key: storageKey,
        contentType: input.declaredMime,
        contentLength: input.sizeBytes,
        expiresInSeconds: uploadSeconds,
      });

      return {
        fileId,
        storageKey,
        url: presigned.url,
        method: presigned.method,
        headers: presigned.headers,
        expiresAt: presigned.expiresAt,
      };
    },

    finalizeUpload(client, fileId) {
      return finalize(deps, client, fileId);
    },

    async requestDownload(client, fileId) {
      const found = await client.query<{
        storage_key: string;
        original_name: string;
      }>(SELECT_USABLE, [fileId]);
      const row = found.rows[0];
      if (row === undefined) {
        /*
         * One answer for four states: absent, another tenant's, not finalised, and not scanned clean.
         * Distinguishing them would tell a caller that a file exists and is infected, which is more
         * than they need and enough to confirm an upload they should not know about.
         */
        throw new NotFoundError('No usable file with that id.');
      }
      assertValidStorageKey(row.storage_key);
      const presigned = await deps.storage.presignDownload({
        key: row.storage_key,
        expiresInSeconds: downloadSeconds,
        filename: row.original_name,
      });
      return { url: presigned.url, expiresAt: presigned.expiresAt };
    },

    async deleteFile(client, fileId) {
      const found = await client.query<{ storage_key: string }>(
        'SELECT storage_key FROM files WHERE id = $1 AND status <> $2',
        [fileId, 'deleted'],
      );
      const row = found.rows[0];
      if (row === undefined) return false;

      /*
       * The ROW is marked deleted first, then the object is removed.
       *
       * This order is chosen, and the other one is wrong. Deleting the object first and then failing
       * to update the row leaves a `ready` file pointing at nothing — every download 404s and the
       * product looks broken. This order can leave an orphaned object, which costs storage and is
       * reaped by a sweep; the row is the source of truth and it already says the file is gone.
       */
      const updated = await client.query(SOFT_DELETE, [fileId, deps.clock.now()]);
      if ((updated.rowCount ?? 0) === 0) return false;
      await deps.storage.delete(row.storage_key);
      return true;
    },
  };
}

/**
 * Finalisation, at module scope.
 *
 * Hoisted out of the factory because it is the longest thing in the package and the factory should read
 * as the four operations it offers. Every check in here re-checks something the reservation only
 * claimed: the first pass tested the uploader's word, and this one tests the object.
 */
async function finalize(
  deps: FileDependencies,
  client: Queryable,
  fileId: string,
): Promise<FinalizeResult> {
  const found = await client.query<ReservedRow>(SELECT_RESERVED, [fileId]);
  const row = found.rows[0];
  if (row === undefined) {
    // Either it does not exist, it belongs to another tenant (the policy hid it), or it has
    // already been finalised. All three are the same answer to a caller.
    throw new NotFoundError('No reserved upload with that id.');
  }

  const stored = await deps.storage.head(row.storage_key);
  if (stored === undefined) {
    throw new ValidationError('No object was uploaded for that reservation.');
  }

  /*
   * The SAME check as at reservation, against the real size and the row's own purpose.
   *
   * Re-running it is the point: the first pass tested a claim, this one tests the object. Reading
   * the purpose from the row rather than re-deriving it is what makes the two passes the same
   * check — a derived purpose would let a client reserve a 64 MB import and finalise a 512 MB
   * media file.
   */
  /*
   * The size and allowlist checks, re-run against the object. A failure here is a REJECTION, so
   * the policy error is caught and turned into one rather than allowed to abort the transaction —
   * which would roll back the very mark that records it.
   */
  let policy: ReturnType<typeof assertUploadAllowed>;
  try {
    policy = assertUploadAllowed({
      purpose: row.purpose,
      declaredMime: row.declared_mime,
      originalName: row.original_name,
      sizeBytes: stored.sizeBytes,
    });
  } catch (error) {
    return reject(
      client,
      deps,
      fileId,
      row.storage_key,
      error instanceof Error ? error.message : String(error),
    );
  }

  const head = await deps.storage.readHead(row.storage_key, SNIFF_BYTES);
  if (head === undefined) {
    throw new ValidationError('The uploaded object could not be read back.');
  }

  const sniffed = sniff(head, row.declared_mime);
  if (sniffed.type === undefined || !purposeAllows(policy, sniffed.type)) {
    return reject(
      client,
      deps,
      fileId,
      row.storage_key,
      sniffed.reason ??
        `A ${policy.purpose} upload may not be ${sniffed.type}. The allowlist is checked ` +
          'against the bytes, not the declared type.',
    );
  }

  const promoted = await client.query(PROMOTE, [
    fileId,
    sniffed.type,
    stored.sizeBytes,
    // A store that cannot supply a digest is not a reason to store none: the column is part of
    // the ready-state constraint, and a file with no digest cannot be checked for corruption
    // later. Stores that cannot compute one are handled by the adapter, not by relaxing this.
    requireChecksum(stored.checksum),
    deps.clock.now(),
  ]);
  if ((promoted.rowCount ?? 0) === 0) {
    // Another finaliser won. Not an error worth raising to the user, but not a success either:
    // the caller's measurement was discarded, and saying so is more honest than returning it.
    throw new ValidationError('That upload was finalised concurrently.');
  }

  return {
    outcome: 'ready',
    fileId,
    mimeType: sniffed.type,
    sizeBytes: stored.sizeBytes,
    checksum: requireChecksum(stored.checksum),
    declarationMismatched: declarationMismatches(sniffed.type, row.declared_mime),
  };
}

/**
 * Marks a reservation rejected and removes the bytes.
 *
 * The ROW survives as `rejected`: a repeated pattern of rejections from one organization is a signal,
 * and an absent row is not. The BYTES do not, because keeping a payload we have just decided is not
 * allowed is how it gets served by mistake later.
 */
async function reject(
  client: Queryable,
  deps: FileDependencies,
  fileId: string,
  storageKey: string,
  reason: string,
): Promise<FinalizeResult> {
  await client.query(REJECT, [fileId]);
  await deps.storage.delete(storageKey);
  return { outcome: 'rejected', fileId, reason };
}

function requireChecksum(checksum: string | null): string {
  if (checksum === null) {
    throw new ValidationError(
      'Storage returned no digest for the uploaded object. A file with no digest cannot be ' +
        'verified later, and the ready state requires one.',
    );
  }
  return checksum;
}
