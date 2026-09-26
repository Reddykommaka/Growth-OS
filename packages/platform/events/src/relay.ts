/**
 * The relay: Postgres → queue.
 *
 * ADR-0007 and 08 §2. It claims unpublished rows, hands them to a sink, and marks them. Three
 * properties are the whole design, and each is a decision that could be got wrong quietly:
 *
 * 1. AT-LEAST-ONCE, NEVER AT-MOST-ONCE. Publish happens BEFORE the row is marked. A crash
 *    between them republishes the event, which every consumer is required to tolerate
 *    (idempotent on event id). The other order would lose events on exactly the same crash,
 *    and losing an event is unrecoverable where a duplicate is merely handled.
 *
 * 2. PER-ORGANIZATION ORDERING, BY AN ADVISORY LOCK. Row-level `FOR UPDATE SKIP LOCKED` alone
 *    does NOT give it: worker A locks an organization's event 1, worker B skips it, takes
 *    event 2 and publishes it first. A transaction-scoped advisory lock keyed on the
 *    organization makes the serialization explicit — one worker owns an organization for the
 *    length of a batch, and other organizations run fully in parallel. Two organizations whose
 *    keys collide merely take turns, which costs throughput and nothing else.
 *
 * 3. A FAILURE STOPS ITS ORGANIZATION AND NOTHING ELSE. Publishing continues in order within
 *    an organization and stops at the first failure, because publishing event 3 after event 2
 *    failed is exactly the reordering property 2 exists to prevent. Past a retry threshold the
 *    row is dead-lettered so the organization drains: a permanent failure must not stop a
 *    tenant's event stream forever.
 */
import type { DomainEvent } from './event.js';

export interface RelayQueryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/** A transaction the relay runs a batch inside. Supplied so the advisory lock is scoped to it. */
export interface RelayTransactor {
  run<T>(fn: (client: RelayQueryable) => Promise<T>): Promise<T>;
}

export interface StagedEvent extends DomainEvent {
  readonly id: string;
  readonly occurredAt: Date;
  readonly attempts: number;
}

/**
 * Where events go. BullMQ in production, a recorder in tests.
 *
 * Takes one event, not a batch: a batch sink would have to report which member failed for
 * ordering to be preserved, and an interface that can be misreported is one that will be.
 */
export interface EventSink {
  publish(event: StagedEvent): Promise<void>;
}

export interface RelayOptions {
  /** Events per organization per pass. Bounded so one busy tenant cannot hold a worker. */
  readonly batchSize?: number;
  /** Organizations touched per pass. */
  readonly organizationsPerPass?: number;
  /**
   * Publish attempts before a row is dead-lettered.
   *
   * Finite on purpose. Infinite retry looks safer and is not: it stops one organization's
   * entire event stream on a single permanently-bad payload, and does so silently.
   */
  readonly maxAttempts?: number;
  readonly now?: () => Date;
}

export interface RelayPass {
  readonly published: number;
  readonly failed: number;
  readonly deadLettered: number;
  /** Organizations skipped because another worker held their lock. Not an error. */
  readonly contended: number;
}

const DEFAULTS = { batchSize: 100, organizationsPerPass: 25, maxAttempts: 10 } as const;

/** Bounded so one pathological error message cannot bloat the queue table. */
const MAX_ERROR_LENGTH = 1000;

const PENDING_ORGANIZATIONS = `
  SELECT organization_id, min(occurred_at) AS oldest
    FROM outbox_events
   WHERE published_at IS NULL AND dead_lettered_at IS NULL
   GROUP BY organization_id
   ORDER BY oldest
   LIMIT $1`;

/**
 * The seed that namespaces the relay's advisory locks.
 *
 * `hashtextextended(text, seed)` returns a 64-bit key, and advisory locks share one global
 * space across the whole database. Seeding with a constant specific to the relay keeps these
 * locks from colliding with any other advisory lock the system takes later — a collision would
 * not corrupt anything, but it would serialize two unrelated subsystems for no reason and be
 * very hard to diagnose.
 *
 * NOT `hashtext(...)::integer`: hashtextextended returns bigint, and narrowing it to the
 * two-integer lock form overflows for most inputs.
 */
export const RELAY_LOCK_SEED = 4711;

/**
 * Takes the organization's relay lock for the length of the transaction, or reports that
 * another worker holds it.
 *
 * Exported so a test can hold the same lock the relay takes. Two definitions of this
 * expression would be two chances for the test to stop testing anything.
 */
export async function tryClaimOrganization(
  client: RelayQueryable,
  organizationId: string,
): Promise<boolean> {
  const lock = await client.query<{ held: boolean }>(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1, $2)) AS held',
    [organizationId, RELAY_LOCK_SEED],
  );
  return lock.rows[0]?.held === true;
}

const BATCH = `
  SELECT id, organization_id, workspace_id, event_name, event_version, payload,
         request_id, actor_user_id, occurred_at, attempts
    FROM outbox_events
   WHERE organization_id = $1 AND published_at IS NULL AND dead_lettered_at IS NULL
   ORDER BY occurred_at, id
   LIMIT $2`;

const MARK_PUBLISHED = `
  UPDATE outbox_events SET published_at = $2, last_error = NULL
   WHERE id = $1 AND published_at IS NULL AND dead_lettered_at IS NULL`;

/*
 * One statement decides retry or dead-letter, because two statements could disagree. The
 * attempts increment and the terminal decision must be the same write, or a crash between them
 * leaves a row that has been tried eleven times and still looks retryable.
 */
const RECORD_FAILURE = `
  UPDATE outbox_events
     SET attempts = attempts + 1,
         last_error = left($2, ${MAX_ERROR_LENGTH}),
         dead_lettered_at = CASE WHEN attempts + 1 >= $3 THEN $4::timestamptz ELSE NULL END
   WHERE id = $1 AND published_at IS NULL AND dead_lettered_at IS NULL
  RETURNING dead_lettered_at IS NOT NULL AS dead`;

interface Row {
  id: string;
  organization_id: string;
  workspace_id: string | null;
  event_name: string;
  event_version: number;
  payload: Record<string, unknown>;
  request_id: string | null;
  actor_user_id: string | null;
  occurred_at: Date;
  attempts: number;
}

const toEvent = (row: Row): StagedEvent => ({
  id: row.id,
  name: row.event_name,
  version: row.event_version,
  organizationId: row.organization_id,
  workspaceId: row.workspace_id,
  payload: row.payload,
  requestId: row.request_id,
  actorUserId: row.actor_user_id,
  occurredAt: row.occurred_at,
  attempts: row.attempts,
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * Relays one organization's batch. Assumes the advisory lock is already held.
 *
 * Returns as soon as one event fails, leaving the rest of the organization's batch for the
 * next pass — in order, behind the event that failed.
 */
async function relayOrganization(
  client: RelayQueryable,
  sink: EventSink,
  organizationId: string,
  options: Required<Omit<RelayOptions, 'now'>> & { now: () => Date },
): Promise<{ published: number; failed: number; deadLettered: number }> {
  const rows = await client.query<Row>(BATCH, [organizationId, options.batchSize]);
  let published = 0;

  for (const row of rows.rows) {
    const event = toEvent(row);
    try {
      await sink.publish(event);
    } catch (error) {
      const outcome = await client.query<{ dead: boolean }>(RECORD_FAILURE, [
        row.id,
        messageOf(error),
        options.maxAttempts,
        options.now(),
      ]);
      // Stop this organization here. Publishing the next event would put it ahead of one that
      // has not been delivered, which is the reordering the advisory lock exists to prevent.
      return {
        published,
        failed: 1,
        deadLettered: outcome.rows[0]?.dead === true ? 1 : 0,
      };
    }
    await client.query(MARK_PUBLISHED, [row.id, options.now()]);
    published += 1;
  }

  return { published, failed: 0, deadLettered: 0 };
}

/**
 * One relay pass. Returns what it did, so a worker can decide whether to poll again
 * immediately or back off.
 *
 * Each organization gets its OWN transaction. One transaction spanning every organization
 * would hold the advisory locks for the whole pass and make a single slow sink call block
 * every other tenant — and a failure late in the pass would roll back the `published_at`
 * marks of events that really were delivered, republishing all of them.
 */
export async function relayOnce(
  transactor: RelayTransactor,
  sink: EventSink,
  options: RelayOptions = {},
): Promise<RelayPass> {
  const settings = {
    batchSize: options.batchSize ?? DEFAULTS.batchSize,
    organizationsPerPass: options.organizationsPerPass ?? DEFAULTS.organizationsPerPass,
    maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
    now: options.now ?? (() => new Date()),
  };

  const organizations = await transactor.run((client) =>
    client.query<{ organization_id: string }>(PENDING_ORGANIZATIONS, [
      settings.organizationsPerPass,
    ]),
  );

  let published = 0;
  let failed = 0;
  let deadLettered = 0;
  let contended = 0;

  for (const { organization_id: organizationId } of organizations.rows) {
    const result = await transactor.run(async (client) => {
      if (!(await tryClaimOrganization(client, organizationId))) return null;
      return relayOrganization(client, sink, organizationId, settings);
    });

    if (result === null) {
      contended += 1;
      continue;
    }
    published += result.published;
    failed += result.failed;
    deadLettered += result.deadLettered;
  }

  return { published, failed, deadLettered, contended };
}

export interface OutboxLag {
  readonly pending: number;
  /** Null when nothing is pending — distinct from zero seconds of lag. */
  readonly oldestSeconds: number | null;
  readonly deadLettered: number;
}

/** Reads the two signals 08 §2 and §3 require alerting on. One definition, two callers. */
export async function readOutboxLag(client: RelayQueryable): Promise<OutboxLag> {
  const lag = await client.query<{ pending: string; oldest_seconds: number | null }>(
    'SELECT pending, oldest_seconds FROM outbox_lag()',
  );
  const dead = await client.query<{ outbox_dead_letter_depth: string }>(
    'SELECT outbox_dead_letter_depth()',
  );
  return {
    pending: Number(lag.rows[0]?.pending ?? 0),
    oldestSeconds: lag.rows[0]?.oldest_seconds ?? null,
    deadLettered: Number(dead.rows[0]?.outbox_dead_letter_depth ?? 0),
  };
}
