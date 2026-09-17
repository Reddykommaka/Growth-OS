/**
 * @growth-os/audit — the append-only, hash-chained audit log.
 *
 * 05-data-architecture.md §9. The record is written in the same transaction as the change it
 * describes, chained per organization so tampering is detectable, and stored in a table the
 * application role cannot UPDATE or DELETE.
 */
export {
  canonicalBytes,
  canonicalJson,
  genesisHash,
  hashEvent,
} from './canonical.js';
export type {
  AuditActor,
  AuditActorType,
  AuditEventInput,
  AuditEventRecord,
  AuditResult,
} from './event.js';
export {
  type AuditPage,
  type AuditQuery,
  type AuditReader,
  createAuditReader,
} from './reader.js';
export {
  type AuditQueryable,
  type AuditRecorder,
  createAuditRecorder,
  type RecorderOptions,
} from './recorder.js';
export { REDACTED, redactMetadata } from './redact.js';
export {
  type AuditEntry,
  type AuditSink,
  apiKeyActor,
  PLATFORM_ORGANIZATION_ID,
  userActor,
} from './sink.js';
export {
  type ChainBreak,
  type ChainVerification,
  type VerifyOptions,
  verifyChain,
} from './verify.js';
