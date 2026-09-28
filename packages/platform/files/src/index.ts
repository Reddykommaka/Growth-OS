/**
 * @growth-os/files — the storage port, the upload policy and the scan gate.
 *
 * Bytes live in object storage and never proxy through an app server (02 §"S3-compatible object
 * storage"), which is what shapes everything here: the server decides in advance what it will permit,
 * and afterwards verifies what actually arrived. Both halves are necessary, because the first works
 * on the uploader's claims and the second on the object.
 *
 * A file is usable only when it is `ready` AND scanned `clean`
 * (10-security-architecture.md §3). Nothing here hands out a download URL for less, and the scan
 * verdict is a column this package's role cannot write.
 *
 * The S3 adapter and the scanner engine are deliberately absent; ADR-0022 records why and what would
 * complete them.
 */

export {
  declarationMismatches,
  SNIFF_BYTES,
  type SniffedType,
  type SniffResult,
  sniff,
} from './magic.js';
export { createMemoryStore, type MemoryStore } from './memory-store.js';
export {
  assertUploadAllowed,
  assertValidStorageKey,
  type FilePurpose,
  generateStorageKey,
  type PurposePolicy,
  policyFor,
  purposeAllows,
  purposes,
  type UploadRequest,
} from './policy.js';
export type {
  Clock,
  IdGenerator,
  PresignedDownload,
  PresignedUpload,
  Queryable,
  StoragePort,
  StoredObject,
} from './ports.js';
export {
  type FileScanner,
  isUsable,
  type PendingScan,
  readScanBacklog,
  type ScanBacklog,
  type ScanOptions,
  type ScanPass,
  type ScanTransactor,
  type ScanVerdict,
  scanOnce,
  scanUnusable,
} from './scan.js';
export {
  createFileService,
  type FileDependencies,
  type FileService,
  type FinalizeResult,
  type ReservedUpload,
  type ReserveInput,
} from './service.js';
