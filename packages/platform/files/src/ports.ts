/**
 * The storage port, and why it is a port.
 *
 * 07-integration-architecture.md §2 lists `StoragePort` with "presigned upload/download, delete,
 * copy, signed public URL". ADR-0013's reasoning about model providers applies here for the same
 * reason: an S3 SDK in product code makes the bucket's API the product's API, and the S3 adapter
 * belongs in `packages/integrations/s3` where the vendor is allowed to be named.
 *
 * It is also what makes this package testable at all. An in-memory store that records what was
 * signed lets the upload protocol be tested end to end without credentials, a bucket or a network —
 * and the protocol, not the transport, is where the security properties live.
 */

export interface PresignedUpload {
  readonly url: string;
  readonly method: 'PUT';
  /**
   * Headers the client MUST send, and which the signature covers.
   *
   * Covering `Content-Length` and `Content-Type` in the signature is what makes the declared size
   * and type binding rather than advisory: a client that sends different ones gets a signature
   * mismatch from storage instead of a stored file we then have to reject.
   */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface PresignedDownload {
  readonly url: string;
  readonly expiresAt: Date;
}

/** What storage reports about an object that is actually there. */
export interface StoredObject {
  readonly sizeBytes: number;
  /** Hex sha256, when the store can supply one. Null when it cannot — see `finalizeUpload`. */
  readonly checksum: string | null;
}

export interface StoragePort {
  /**
   * A URL the client PUTs to directly.
   *
   * Direct-to-storage, so bytes never proxy through our app servers (02 §"S3-compatible object
   * storage"). That is a capacity decision and a security one: an app server that streams uploads
   * is an app server that can be exhausted by them.
   */
  presignUpload(input: {
    readonly key: string;
    readonly contentType: string;
    readonly contentLength: number;
    readonly expiresInSeconds: number;
  }): Promise<PresignedUpload>;

  /**
   * A short-lived URL the client GETs.
   *
   * `filename` sets `Content-Disposition`, and `disposition` is NEVER `inline` for user content:
   * 10-security-architecture.md §3 requires user content to be served from a separate origin and
   * forbids rendering user-supplied SVG inline. Attachment is the default the port offers.
   */
  presignDownload(input: {
    readonly key: string;
    readonly expiresInSeconds: number;
    readonly filename: string;
  }): Promise<PresignedDownload>;

  /** What is actually stored, or undefined when the object is absent. */
  head(key: string): Promise<StoredObject | undefined>;

  /**
   * Reads the first `bytes` of an object.
   *
   * Exists for the magic-byte check, which must happen SERVER-side: the client uploaded directly, so
   * nothing has looked at the bytes yet, and the client's word about what it sent is the thing being
   * verified. A ranged read is used rather than a full download because sniffing needs 64 bytes and
   * the object may be half a gigabyte.
   */
  readHead(key: string, bytes: number): Promise<Buffer | undefined>;

  delete(key: string): Promise<void>;
  copy(input: { readonly from: string; readonly to: string }): Promise<void>;
}

export interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
