/**
 * Backlog checks: the shared state that says whether the system is keeping up.
 *
 * Separated from `checks.ts` because these four share a rationale that the connectivity checks do not.
 * Each reads ONE shared table, so its answer is identical on every replica — and that is why none of
 * them is `critical`. A critical check here would empty the load balancer everywhere at once, for a
 * condition that removing replicas cannot fix and that leaves most requests perfectly serveable. It
 * would convert a degradation into an outage, which is the opposite of what a readiness probe is for.
 *
 * They differ in what "behind" MEANS, and each says so in its own words: a stalled relay is late work,
 * a stalled mail sender is invitations not leaving the building, an exhausted partition is writes being
 * refused, and an unscanned upload is a file the customer cannot open.
 */
import type { HealthCheck } from './index.js';

export interface PartitionHeadroomReading {
  readonly parentTable: string;
  /**
   * Whole months of runway beyond the current month. `-1` means no partition covers
   * `now()`: the table is already refusing writes.
   */
  readonly monthsAhead: number;
}

export interface PartitionHeadroomSource {
  headroom(): Promise<readonly PartitionHeadroomReading[]>;
}

/**
 * How much runway must remain before the check warns.
 *
 * Matches the maintenance job's own threshold. Two months, not zero: a table that has
 * already run out cannot be written to, so a check that only fires at zero fires during the
 * outage rather than before it.
 */
export const MINIMUM_PARTITION_HEADROOM_MONTHS = 2;

/**
 * Runway before a partitioned table stops accepting writes.
 *
 * This is the only warning available before a real cliff. Every unbounded-growth fact table
 * is RANGE-partitioned monthly (05-data-architecture.md §7) and a partitioned table with no
 * partition covering `now()` REJECTS the insert — so for `audit_events` the failure mode is
 * every audited write in the product failing at once, on the first of a month, with no
 * preceding symptom. The maintenance job pre-creates three months ahead on every deploy;
 * this check is what notices when that has stopped happening.
 *
 * NOT CRITICAL, deliberately, even when a table has already run out. Headroom is identical
 * on every replica, so a critical check would take the entire fleet out of the load balancer
 * simultaneously — converting "one table cannot be written to" into "nothing serves at all",
 * and removing the replicas that were still serving every unaffected request. The condition
 * needs an operator and a migrator credential, neither of which a readiness probe has.
 */
export function partitionHeadroomCheck(
  source: PartitionHeadroomSource,
  minimumMonths: number = MINIMUM_PARTITION_HEADROOM_MONTHS,
): HealthCheck {
  return {
    name: 'partition-headroom',
    critical: false,
    async run() {
      const readings = await source.headroom();
      if (readings.length === 0) {
        // An empty registry is not "healthy": it means nothing is being maintained, which
        // looks exactly like a passing check right up until the first table runs out.
        return { status: 'warn', detail: 'no partitioned tables are registered for maintenance' };
      }

      const exhausted = readings.filter((r) => r.monthsAhead < 0);
      const short = readings.filter((r) => r.monthsAhead >= 0 && r.monthsAhead < minimumMonths);
      const observed = readings
        .map((r) => `${r.parentTable}=${r.monthsAhead}`)
        .sort()
        .join(' ');

      if (exhausted.length > 0) {
        return {
          status: 'fail',
          observedValue: observed,
          detail:
            `${exhausted.map((r) => r.parentTable).join(', ')} has no partition covering now() ` +
            'and is refusing writes. Run the partition maintenance job.',
        };
      }
      if (short.length > 0) {
        return {
          status: 'warn',
          observedValue: observed,
          detail:
            `${short.map((r) => r.parentTable).join(', ')} below ${minimumMonths} months of ` +
            'headroom. The maintenance job has not run recently enough.',
        };
      }
      return { status: 'pass', observedValue: observed };
    },
  };
}

export interface QueueLagReading {
  readonly pending: number;
  /** Null when nothing is pending — distinct from zero seconds of lag. */
  readonly oldestSeconds: number | null;
  readonly deadLettered: number;
}

export interface QueueLagSource {
  lag(): Promise<QueueLagReading>;
}

export interface QueueLagThresholds {
  /** Seconds of lag above which the queue is behind enough to say so. */
  readonly warnSeconds?: number;
  /** Seconds of lag that means the drainer has stopped, not merely slowed. */
  readonly failSeconds?: number;
  /** Dead-letter depth above which a human is needed. */
  readonly warnDeadLettered?: number;
}

/** Retained as the name the outbox source is read under. See `queueLagCheck`. */
export type OutboxLagReading = QueueLagReading;
export type OutboxLagSource = QueueLagSource;
export type OutboxLagThresholds = QueueLagThresholds;

/** What the queue holds, and what a stalled drainer means for it. */
export interface QueueDescription {
  readonly name: string;
  /** Singular noun for the queued thing: "event", "message". */
  readonly item: string;
  /** What a full stall means, in a sentence an operator can act on. */
  readonly stalled: string;
}

/**
 * Lag on a drain-and-mark queue. 08 §2 requires alerting on it.
 *
 * WHY LAG IS MEASURED IN AGE, NOT DEPTH. A queue holding ten thousand items that drains in a
 * second is healthy; one holding three that have sat for an hour is an incident. Depth is
 * reported for context and the thresholds are on age.
 *
 * NOT CRITICAL, for the same reason the partition-headroom check is not: queue lag is a fact
 * about one shared table, identical on every replica, so a critical check would empty the load
 * balancer everywhere at once. Worse, it would do so for a condition that makes writes NO less
 * correct — the outbox exists precisely so that a stalled drainer degrades throughput rather
 * than correctness. Refusing traffic would convert the degradation the design was built to
 * survive into the outage it was built to avoid.
 *
 * DEAD-LETTER DEPTH IS A SEPARATE SIGNAL, never folded into lag. A dead-lettered item will never
 * be drained, so counting it as lag leaves the lag threshold permanently exceeded — and a
 * permanently firing alert is how a real backlog goes unnoticed.
 *
 * ONE IMPLEMENTATION, TWO QUEUES. `outbox_events` and `outbound_messages` are drained by
 * different code with different failure semantics, but they are monitored identically and the
 * reasoning above applies word for word to both. Two copies of it would be two places for the
 * thresholds to drift apart, and a monitoring difference between them would be an accident
 * rather than a decision.
 */
export function queueLagCheck(
  queue: QueueDescription,
  source: QueueLagSource,
  thresholds: QueueLagThresholds = {},
): HealthCheck {
  const warnSeconds = thresholds.warnSeconds ?? 60;
  const failSeconds = thresholds.failSeconds ?? 600;
  const warnDeadLettered = thresholds.warnDeadLettered ?? 1;

  return {
    name: queue.name,
    critical: false,
    async run() {
      const reading = await source.lag();
      const age = reading.oldestSeconds ?? 0;
      const observed =
        `pending=${reading.pending} oldest=${reading.oldestSeconds ?? 'none'} ` +
        `dead=${reading.deadLettered}`;

      if (age >= failSeconds) {
        return {
          status: 'fail',
          observedValue: observed,
          detail: `the oldest undrained ${queue.item} is ${Math.round(age)}s old. ${queue.stalled}`,
        };
      }
      if (age >= warnSeconds) {
        return {
          status: 'warn',
          observedValue: observed,
          detail: `${Math.round(age)}s behind.`,
        };
      }
      if (reading.deadLettered >= warnDeadLettered) {
        return {
          status: 'warn',
          observedValue: observed,
          detail:
            `${reading.deadLettered} ${queue.item}(s) are dead-lettered and will never be ` +
            'delivered without a replay. Inspect and replay them.',
        };
      }
      return { status: 'pass', observedValue: observed };
    },
  };
}

/** Outbox relay lag (ADR-0007). */
export const outboxLagCheck = (
  source: QueueLagSource,
  thresholds: QueueLagThresholds = {},
): HealthCheck =>
  queueLagCheck(
    {
      name: 'outbox-lag',
      item: 'event',
      stalled: 'The relay has stopped, not slowed: no domain event has reached a consumer since.',
    },
    source,
    thresholds,
  );

/**
 * Outbound message queue lag (migration 0016).
 *
 * Worth alerting on separately from the outbox even though both are drained by the same process:
 * a stalled sender means invitations, password-change notices and payment warnings are not
 * leaving the building, and that is visible to customers in a way a stalled relay is not.
 */
export const outboundMessageLagCheck = (
  source: QueueLagSource,
  thresholds: QueueLagThresholds = {},
): HealthCheck =>
  queueLagCheck(
    {
      name: 'outbound-message-lag',
      item: 'message',
      stalled:
        'The sender has stopped: no invitation, security notice or billing warning has left ' +
        'the product since.',
    },
    source,
    thresholds,
  );

export interface ScanBacklogReading {
  readonly awaiting: number;
  /** Null when nothing is awaiting — distinct from zero seconds of backlog. */
  readonly oldestSeconds: number | null;
  readonly infected: number;
  readonly failed: number;
}

export interface ScanBacklogSource {
  backlog(): Promise<ScanBacklogReading>;
}

/**
 * The malware-scan backlog.
 *
 * NOT a queue-lag check, despite looking like one, and the difference is worth stating because reusing
 * `queueLagCheck` here would be wrong. For the outbox and the mail queue, a stalled drainer means work
 * is late. For this one it means **uploads are unusable**: an unscanned file has no download URL
 * (10-security-architecture.md §3), so a stopped scanner degrades to a product where nothing a customer
 * uploads can be opened. That is a different severity and a different message, and it fails at a much
 * shorter age than a mail backlog would.
 *
 * Still not critical. The condition is identical on every replica, so removing them from the load
 * balancer would take down every request that has nothing to do with files — and it would not scan a
 * single byte.
 *
 * `failed` is warned on separately from `infected`. An infected file is the scanner WORKING; a failed
 * one is the scanner unable to answer, and those files sit unusable with nothing retrying them.
 */
export function scanBacklogCheck(
  source: ScanBacklogSource,
  thresholds: { readonly warnSeconds?: number; readonly failSeconds?: number } = {},
): HealthCheck {
  const warnSeconds = thresholds.warnSeconds ?? 60;
  const failSeconds = thresholds.failSeconds ?? 300;

  return {
    name: 'file-scan-backlog',
    critical: false,
    async run() {
      const reading = await source.backlog();
      const age = reading.oldestSeconds ?? 0;
      const observed =
        `awaiting=${reading.awaiting} oldest=${reading.oldestSeconds ?? 'none'} ` +
        `infected=${reading.infected} failed=${reading.failed}`;

      if (age >= failSeconds) {
        return {
          status: 'fail',
          observedValue: observed,
          detail:
            `the oldest unscanned upload is ${Math.round(age)}s old. Nothing a customer uploads ` +
            'can be opened until it is scanned, so this is a visible product outage.',
        };
      }
      if (age >= warnSeconds) {
        return {
          status: 'warn',
          observedValue: observed,
          detail: `${reading.awaiting} upload(s) unscanned, oldest ${Math.round(age)}s.`,
        };
      }
      if (reading.failed > 0) {
        return {
          status: 'warn',
          observedValue: observed,
          detail:
            `${reading.failed} file(s) could not be scanned and are unusable with nothing ` +
            'retrying them. An infected verdict is the scanner working; a failed one is not.',
        };
      }
      return { status: 'pass', observedValue: observed };
    },
  };
}
