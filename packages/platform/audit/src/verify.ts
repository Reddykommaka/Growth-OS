/**
 * Chain verification.
 *
 * Recomputes every hash from the events themselves and checks that each links to the one
 * before it. It trusts nothing stored alongside the rows — not the recorded hash, not the
 * chain head — because those are exactly what an attacker with write access would adjust.
 */

import { genesisHash, hashEvent } from './canonical.js';
import type { AuditEventRecord } from './event.js';

export type ChainBreak =
  | { readonly kind: 'hash_mismatch'; readonly sequence: number; readonly eventId: string }
  | { readonly kind: 'broken_link'; readonly sequence: number; readonly eventId: string }
  | { readonly kind: 'sequence_gap'; readonly expected: number; readonly found: number }
  | { readonly kind: 'wrong_organization'; readonly sequence: number; readonly eventId: string }
  | { readonly kind: 'bad_genesis'; readonly sequence: number; readonly eventId: string };

export interface ChainVerification {
  readonly valid: boolean;
  readonly checked: number;
  readonly breaks: readonly ChainBreak[];
}

export interface VerifyOptions {
  /**
   * The sequence the slice is expected to start at, and the hash it should chain from.
   *
   * Verifying a slice rather than a whole chain is the normal case — a tenant's log does not
   * fit in memory after a year. Given neither, the slice is treated as starting at sequence
   * 1 and chaining from genesis.
   */
  readonly startingAfter?: { readonly sequence: number; readonly hash: Buffer } | undefined;
}

/**
 * Verifies a contiguous, ascending run of one organization's events.
 *
 * Reports EVERY break rather than stopping at the first: during an incident the question is
 * how much of the log can still be trusted, and the answer is the shape of the damage, not
 * its earliest point. Verification continues from each event's own recorded hash after a
 * mismatch, so one altered row does not cascade into a report that every later row is bad.
 */
export function verifyChain(
  organizationId: string,
  events: readonly AuditEventRecord[],
  options: VerifyOptions = {},
): ChainVerification {
  const breaks: ChainBreak[] = [];
  const start = options.startingAfter;
  let expectedSequence = start === undefined ? 1 : start.sequence + 1;
  let expectedPrev = start === undefined ? genesisHash(organizationId) : start.hash;

  for (const event of events) {
    if (event.organizationId !== organizationId) {
      breaks.push({
        kind: 'wrong_organization',
        sequence: event.sequence,
        eventId: event.id,
      });
    }

    if (event.sequence !== expectedSequence) {
      breaks.push({ kind: 'sequence_gap', expected: expectedSequence, found: event.sequence });
      // Resynchronise, so one gap does not report every subsequent event as misplaced.
      expectedSequence = event.sequence;
    }

    if (!event.prevHash.equals(expectedPrev)) {
      breaks.push({
        // The first event of a chain that does not start from the organization's genesis is
        // a distinct failure: the chain was started somewhere else, or re-started here.
        kind: expectedSequence === 1 ? 'bad_genesis' : 'broken_link',
        sequence: event.sequence,
        eventId: event.id,
      });
    }

    const recomputed = hashEvent(event, event.prevHash);
    if (!recomputed.equals(event.hash)) {
      breaks.push({ kind: 'hash_mismatch', sequence: event.sequence, eventId: event.id });
    }

    // Continue from what this row actually claims. Using the recomputed value instead would
    // make a single tampered row report every later row as broken too, which hides the
    // extent of the damage rather than showing it.
    expectedPrev = event.hash;
    expectedSequence = event.sequence + 1;
  }

  return { valid: breaks.length === 0, checked: events.length, breaks };
}
