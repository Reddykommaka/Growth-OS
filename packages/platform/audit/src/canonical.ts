/**
 * The canonical byte form of an audit event, and the hash over it.
 *
 * Everything the chain guarantees rests on this being DETERMINISTIC and UNAMBIGUOUS. Two
 * encodings of the same event must produce identical bytes, or verification fails on honest
 * data; two DIFFERENT events must never produce identical bytes, or a forgery verifies.
 *
 * WHY NOT `JSON.stringify`. It is deterministic only by accident: key order follows
 * insertion, which differs between a freshly built object and one read back from `jsonb`;
 * `undefined` members vanish while `null` survives; and non-ASCII escaping is
 * implementation-defined. A chain built on it breaks the first time a row round-trips
 * through the database.
 *
 * WHY LENGTH PREFIXES. Plain concatenation is ambiguous: the fields ("ab", "c") and
 * ("a", "bc") both yield "abc", so one event could be re-encoded as a different one with the
 * same hash. Every value is written as its byte length followed by its bytes, which makes
 * the boundary between fields unforgeable.
 */

import { createHash } from 'node:crypto';
import type { AuditEventRecord } from './event.js';

/** Domain separation, so an audit hash can never be mistaken for any other hash we compute. */
const DOMAIN = 'growth-os/audit/v1';

/**
 * The chain's starting value for an organization.
 *
 * Derived from the organization id rather than being a constant, so one tenant's chain
 * cannot be spliced onto another's: an event copied between organizations no longer verifies
 * because the value it chains from belongs to a different chain.
 */
export function genesisHash(organizationId: string): Buffer {
  return createHash('sha256').update(`${DOMAIN}/genesis:${organizationId}`, 'utf8').digest();
}

/** `len(bytes) ‖ bytes`, the unambiguous framing every field goes through. */
function framed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

/** An absent value. Distinct from the empty string, which frames as a zero-length field. */
const ABSENT = Buffer.from([0xff, 0xff, 0xff, 0xff]);

function optional(value: string | null | undefined): Buffer {
  return value === null || value === undefined ? ABSENT : framed(value);
}

/**
 * Deterministic JSON for the metadata object.
 *
 * Keys are sorted at every level, so an object rebuilt in a different order encodes
 * identically. `undefined` is dropped exactly as `JSON.stringify` would drop it, because
 * that is what the database will have stored. Arrays keep their order — order is meaning in
 * an array, and reordering one is a change worth detecting.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The fields covered by the hash, in a FIXED order. Changing this changes every hash. */
export function canonicalBytes(event: Omit<AuditEventRecord, 'hash' | 'prevHash'>): Buffer {
  return Buffer.concat([
    framed(DOMAIN),
    framed(event.id),
    framed(event.organizationId),
    framed(String(event.sequence)),
    // Milliseconds, in UTC, always. `toISOString` is fixed-format and does not vary with the
    // host's locale or timezone — `toString` would.
    framed(event.occurredAt.toISOString()),
    framed(event.actor.type),
    optional(event.actor.userId),
    optional(event.actor.apiKeyId),
    optional(event.actor.impersonatorUserId),
    framed(event.action),
    framed(event.resourceType),
    framed(event.resourceId),
    optional(event.workspaceId),
    framed(event.result),
    optional(event.ip),
    optional(event.userAgent),
    optional(event.requestId),
    framed(canonicalJson(event.metadata)),
  ]);
}

/** `H(prev_hash ‖ canonical(row))`, per 05-data-architecture.md §9. */
export function hashEvent(
  event: Omit<AuditEventRecord, 'hash' | 'prevHash'>,
  prevHash: Buffer,
): Buffer {
  return createHash('sha256').update(prevHash).update(canonicalBytes(event)).digest();
}
