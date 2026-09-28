/**
 * The outbound sender: queue → channel.
 *
 * Deliberately the same shape as the outbox relay, because it is the same problem with one extra
 * constraint. The shared properties:
 *
 *   - CLAIM, SEND, MARK, in that order. A crash between the send and the mark re-sends, which for
 *     mail is a duplicate the recipient tolerates; marking first would silently drop it, and a
 *     dropped invitation is indistinguishable from an invitation that was never created.
 *   - A terminal dead-letter state past a threshold, so one undeliverable address cannot be
 *     retried forever.
 *   - `FOR UPDATE SKIP LOCKED`, so replicas share the queue without a distributed lock.
 *
 * The one difference, and it is why there is no advisory lock here: MAIL HAS NO ORDERING
 * GUARANTEE TO PRESERVE. Two messages to the same person are independent, so a failure must not
 * block the queue behind it — the opposite of the relay, where publishing event 3 after event 2
 * failed would break the guarantee the relay exists to make.
 */
import { type MessageEnvelope, openEnvelope } from './envelope.js';
import type { MessageCipher, Queryable } from './ports.js';

export interface SenderQueryable extends Queryable {}

export interface SenderTransactor {
  run<T>(fn: (client: SenderQueryable) => Promise<T>): Promise<T>;
}

export interface OutboundMessage {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string | null;
  readonly channel: string;
  readonly type: string;
  readonly attempts: number;
  readonly envelope: MessageEnvelope;
}

/** A transport. One implementation per channel; a recorder in tests. */
export interface MessageChannel {
  readonly channel: string;
  send(message: OutboundMessage): Promise<void>;
}

export interface SenderOptions {
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly now?: () => Date;
}

export interface SenderPass {
  readonly sent: number;
  readonly failed: number;
  readonly deadLettered: number;
  /** Messages whose channel has no registered transport. Not retried; dead-lettered at once. */
  readonly unroutable: number;
}

const DEFAULTS = { batchSize: 50, maxAttempts: 5 } as const;
const MAX_ERROR_LENGTH = 1000;

/*
 * The claim. `FOR UPDATE SKIP LOCKED` is what lets several worker replicas drain one queue
 * without a distributed lock: a row another worker holds is invisible to this one rather than
 * blocking it.
 */
const CLAIM = `
  SELECT id, organization_id, workspace_id, channel, envelope, type, attempts
    FROM outbound_messages
   WHERE status = 'pending'
   ORDER BY created_at
   LIMIT $1
   FOR UPDATE SKIP LOCKED`;

const MARK_SENT = `
  UPDATE outbound_messages
     SET status = 'sent', sent_at = $2, last_error = NULL
   WHERE id = $1 AND status = 'pending'`;

/*
 * One statement decides retry or dead-letter. Two could disagree: a crash between an attempts
 * increment and a terminal decision leaves a row that has been tried six times and still looks
 * retryable.
 */
const RECORD_FAILURE = `
  UPDATE outbound_messages
     SET attempts = attempts + 1,
         last_error = left($2, ${MAX_ERROR_LENGTH}),
         status = CASE WHEN attempts + 1 >= $3 THEN 'dead_lettered' ELSE 'pending' END,
         dead_lettered_at = CASE WHEN attempts + 1 >= $3 THEN $4::timestamptz ELSE NULL END
   WHERE id = $1 AND status = 'pending'
  RETURNING status = 'dead_lettered' AS dead`;

/*
 * An unroutable message is dead on arrival, not retryable: no number of retries will conjure a
 * transport for a channel nothing implements. Retrying it would hide a configuration error behind
 * a growing queue.
 */
const MARK_UNROUTABLE = `
  UPDATE outbound_messages
     SET status = 'dead_lettered', dead_lettered_at = $2::timestamptz,
         attempts = attempts + 1, last_error = $3
   WHERE id = $1 AND status = 'pending'`;

interface Row {
  id: string;
  organization_id: string;
  workspace_id: string | null;
  channel: string;
  envelope: Buffer;
  type: string;
  attempts: number;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * One sender pass.
 *
 * Everything runs in ONE transaction, unlike the relay's per-organization transactions. The
 * claim's row locks are what keep two workers off the same message, and they last only as long as
 * the transaction — so the batch is bounded and a slow transport costs held locks rather than
 * duplicate sends. The relay needed separate transactions because its advisory locks were
 * per-organization and a failure late in a pass would have rolled back earlier publishes; here a
 * rollback would re-send, which is the tolerated direction.
 */
export async function sendOnce(
  transactor: SenderTransactor,
  channels: readonly MessageChannel[],
  cipher: MessageCipher,
  options: SenderOptions = {},
): Promise<SenderPass> {
  const batchSize = options.batchSize ?? DEFAULTS.batchSize;
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const now = options.now ?? (() => new Date());
  const byChannel = new Map(channels.map((c) => [c.channel, c]));

  return transactor.run(async (client) => {
    const claimed = await client.query<Row>(CLAIM, [batchSize]);
    let sent = 0;
    let failed = 0;
    let deadLettered = 0;
    let unroutable = 0;

    for (const row of claimed.rows) {
      const transport = byChannel.get(row.channel);
      if (transport === undefined) {
        await client.query(MARK_UNROUTABLE, [
          row.id,
          now(),
          `no transport is registered for channel "${row.channel}"`,
        ]);
        unroutable += 1;
        deadLettered += 1;
        continue;
      }

      let message: OutboundMessage;
      try {
        message = {
          id: row.id,
          organizationId: row.organization_id,
          workspaceId: row.workspace_id,
          channel: row.channel,
          type: row.type,
          attempts: row.attempts,
          // Decryption failure is NOT a transport failure and must not be retried: a wrong key or
          // a tampered ciphertext will fail identically every time, and retrying would bury a
          // key-rotation mistake under a growing queue instead of surfacing it.
          envelope: openEnvelope(cipher, row.envelope),
        };
      } catch (error) {
        await client.query(MARK_UNROUTABLE, [row.id, now(), messageOf(error)]);
        deadLettered += 1;
        continue;
      }

      try {
        await transport.send(message);
      } catch (error) {
        const outcome = await client.query<{ dead: boolean }>(RECORD_FAILURE, [
          row.id,
          messageOf(error),
          maxAttempts,
          now(),
        ]);
        failed += 1;
        if (outcome.rows[0]?.dead === true) deadLettered += 1;
        // No `break`. Mail has no ordering guarantee, so one bad address must not hold up the
        // queue behind it — the opposite of the relay's deliberate stop.
        continue;
      }
      await client.query(MARK_SENT, [row.id, now()]);
      sent += 1;
    }

    return { sent, failed, deadLettered, unroutable };
  });
}

export interface OutboundLag {
  readonly pending: number;
  readonly oldestSeconds: number | null;
  readonly deadLettered: number;
}

/** The queue's two signals, from the one definition migration 0016 installs. */
export async function readOutboundLag(client: Queryable): Promise<OutboundLag> {
  const result = await client.query<{
    pending: string;
    oldest_seconds: number | null;
    dead_lettered: string;
  }>('SELECT pending, oldest_seconds, dead_lettered FROM outbound_message_lag()');
  return {
    pending: Number(result.rows[0]?.pending ?? 0),
    oldestSeconds: result.rows[0]?.oldest_seconds ?? null,
    deadLettered: Number(result.rows[0]?.dead_lettered ?? 0),
  };
}
