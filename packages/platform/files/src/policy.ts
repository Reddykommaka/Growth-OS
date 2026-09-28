/**
 * Upload policy: what may be stored, how big, and under what key.
 *
 * Separated from the service so the answers are reviewable in one place. An upload policy spread
 * across a handler, a validator and a repository is one nobody can state, and "what can a customer
 * upload" is a question that gets asked in a security review.
 */

import { randomUUID } from 'node:crypto';
import { ValidationError } from '@growth-os/errors';
import type { SniffedType } from './magic.js';

/** What a file is FOR. The category decides the size cap and the allowed types. */
export type FilePurpose = 'media' | 'document' | 'import' | 'export';

export interface PurposePolicy {
  readonly purpose: FilePurpose;
  readonly allowed: readonly SniffedType[];
  readonly maxBytes: number;
  readonly description: string;
}

const MB = 1024 * 1024;

/*
 * Caps are per purpose rather than global, because one global cap has to be the largest one and then
 * applies to the smallest case. A 512 MB limit chosen for video would let a CSV import be 512 MB,
 * and the import path holds that file in a worker.
 */
const POLICIES: readonly PurposePolicy[] = [
  {
    purpose: 'media',
    allowed: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4'],
    maxBytes: 512 * MB,
    description: 'Images and video attached to posts, listings and campaigns.',
  },
  {
    purpose: 'document',
    allowed: ['application/pdf', 'image/png', 'image/jpeg'],
    maxBytes: 32 * MB,
    description: 'Contracts, invoices and briefs. PDF and scans.',
  },
  {
    purpose: 'import',
    // Text only, and deliberately not PDF: an import is parsed, and a format we parse must be one
    // whose parser we control.
    allowed: ['text/csv', 'text/plain'],
    maxBytes: 64 * MB,
    description: 'CSV and text imports of contacts, listings and historical metrics.',
  },
  {
    purpose: 'export',
    allowed: ['text/csv', 'text/plain', 'application/pdf'],
    maxBytes: 1024 * MB,
    description: 'Exports the product generates. Larger, because nobody uploads one.',
  },
];

const BY_PURPOSE = new Map(POLICIES.map((p) => [p.purpose, p]));

export function policyFor(purpose: string): PurposePolicy | undefined {
  return BY_PURPOSE.get(purpose as FilePurpose);
}

export function purposes(): readonly FilePurpose[] {
  return POLICIES.map((p) => p.purpose);
}

/**
 * The storage key.
 *
 * SERVER-GENERATED, and no part of it comes from the client. A client-supplied key — even one that
 * is merely appended to a prefix — is a path-traversal primitive and a cross-tenant one: `../`, or
 * another organization's id, would let one tenant overwrite another's object, and the presigned URL
 * would make the write legitimate.
 *
 * The organization id is IN the key rather than only in the row. It costs nothing and it means a
 * bucket-level audit, a lifecycle rule and an incident investigation can all attribute an object
 * without joining to the database — including after the row is gone.
 *
 * The date segments exist for lifecycle rules, which express themselves as key prefixes in every
 * S3-compatible implementation.
 */
export function generateStorageKey(organizationId: string, at: Date): string {
  const year = at.getUTCFullYear().toString().padStart(4, '0');
  const month = (at.getUTCMonth() + 1).toString().padStart(2, '0');
  return `org/${organizationId}/${year}/${month}/${randomUUID()}`;
}

/** The shape migration 0017's CHECK constraint enforces. Duplicated deliberately — see below. */
const STORAGE_KEY = /^org\/[0-9a-f-]{36}\/[0-9]{4}\/[0-9]{2}\/[0-9a-f-]{36}$/;

/**
 * Validates a storage key before it is used in a presigned URL.
 *
 * The database already constrains the column, so this looks redundant and is not: a presigned URL is
 * minted from a key, and a key that never reached the database would never meet that constraint. The
 * two checks guard different moments — the row, and the signature — and the signature is the one that
 * grants write access to a bucket path.
 */
export function assertValidStorageKey(key: string): void {
  if (!STORAGE_KEY.test(key)) {
    throw new ValidationError(
      'Refusing to sign a storage key that this system did not generate. Keys are ' +
        'server-generated; a client-influenced key is a path-traversal and cross-tenant write.',
    );
  }
}

/**
 * A control character, a path separator, or DEL in a filename.
 *
 * A code-point scan rather than a character-class regexp: a regexp containing literal control
 * characters is almost always a mistake, which is why the linter objects to one, and the intent reads
 * more plainly as a range check than as escape sequences a reader has to decode.
 */
function hasControlCharacterOrSeparator(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
    // `/` and `\\`: a download would write outside the directory the user chose.
    if (code === 0x2f || code === 0x5c) return true;
  }
  return false;
}

export interface UploadRequest {
  readonly purpose: string;
  readonly declaredMime: string;
  readonly originalName: string;
  /** What the client says it will upload. Checked again against storage at finalisation. */
  readonly sizeBytes: number;
}

/**
 * Checks an upload request before a URL is minted.
 *
 * The declared size is checked here and the ACTUAL size is checked again at finalisation, because
 * this one is a claim. Checking only here would let a client declare one byte and upload a gigabyte;
 * checking only at finalisation would mean the gigabyte is already in the bucket before we object.
 * Both, and the first one is the cheap one.
 */
export function assertUploadAllowed(request: UploadRequest): PurposePolicy {
  const policy = policyFor(request.purpose);
  if (policy === undefined) {
    throw new ValidationError(
      `Unknown upload purpose "${request.purpose}". Allowed: ${purposes().join(', ')}.`,
    );
  }
  if (!Number.isInteger(request.sizeBytes) || request.sizeBytes <= 0) {
    throw new ValidationError('An upload must declare a positive, whole size in bytes.');
  }
  if (request.sizeBytes > policy.maxBytes) {
    throw new ValidationError(
      `A ${policy.purpose} upload may be at most ${policy.maxBytes} bytes; ` +
        `${request.sizeBytes} was declared.`,
    );
  }
  if (request.originalName.trim().length === 0) {
    throw new ValidationError('An upload must have a name.');
  }
  /*
   * The original name is stored and later offered as a download filename, so it is checked even
   * though it never reaches the storage key. A newline in it is header injection into
   * `Content-Disposition`; a path separator makes a download write outside the directory the user
   * chose.
   */
  if (hasControlCharacterOrSeparator(request.originalName)) {
    throw new ValidationError(
      'A filename may not contain control characters or path separators: it is offered back as a ' +
        'Content-Disposition filename, where both are an injection.',
    );
  }
  return policy;
}

/** True when a purpose permits a sniffed type. The sniffer decides WHAT; this decides WHETHER. */
export const purposeAllows = (policy: PurposePolicy, sniffed: SniffedType): boolean =>
  policy.allowed.includes(sniffed);
