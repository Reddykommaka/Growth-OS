/**
 * The outbox writer.
 *
 * ADR-0007: the event is INSERTed in the same transaction as the state change. This module
 * therefore takes a `Queryable` — the caller's open transaction — and never opens one of its
 * own. A writer that managed its own connection would be the dual-write bug with extra steps:
 * the event would commit separately from the change it describes.
 */
import { InternalError } from '@growth-os/errors';
import { assertPublishable, type DomainEvent } from './event.js';

export interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/** What the domain layer depends on. The only surface a module needs to emit an event. */
export interface EventPublisher {
  /** Stages one event. Returns its id, so a caller can assert on it in a test. */
  stage(event: DomainEvent): Promise<string>;
  /** Stages several in one statement. Ordering within the batch is preserved. */
  stageAll(events: readonly DomainEvent[]): Promise<readonly string[]>;
}

/*
 * `coalesce(staged.occurred_at, now())` rather than relying on the column DEFAULT.
 *
 * An INSERT ... SELECT supplies the column explicitly, so a NULL in the SELECT list is stored
 * as NULL and the DEFAULT never fires — which the NOT NULL constraint then rejects. Leaving
 * the column out of the statement entirely is not an option either, because a caller that DOES
 * know the instant must be able to supply it.
 */
const INSERT = `
  INSERT INTO outbox_events
    (organization_id, workspace_id, event_name, event_version, payload,
     request_id, actor_user_id, occurred_at)
  SELECT staged.organization_id, staged.workspace_id, staged.event_name, staged.event_version,
         staged.payload, staged.request_id, staged.actor_user_id,
         coalesce(staged.occurred_at, now())
    FROM unnest(
      $1::uuid[], $2::uuid[], $3::text[], $4::integer[], $5::jsonb[],
      $6::text[], $7::uuid[], $8::timestamptz[]
    ) AS staged(organization_id, workspace_id, event_name, event_version, payload,
                request_id, actor_user_id, occurred_at)
  RETURNING id`;

/**
 * Stages events against the caller's transaction.
 *
 * `stageAll` is one statement rather than a loop, because a module that emits three events
 * from one write should pay one round trip. `unnest` over parallel arrays keeps it a single
 * parameterised statement — building a multi-row VALUES list by string concatenation is how a
 * payload ends up interpolated into SQL.
 */
export function createOutboxPublisher(client: Queryable): EventPublisher {
  async function stageAll(events: readonly DomainEvent[]): Promise<readonly string[]> {
    if (events.length === 0) return [];
    for (const event of events) assertPublishable(event);

    const result = await client.query<{ id: string }>(INSERT, [
      events.map((e) => e.organizationId),
      events.map((e) => e.workspaceId ?? null),
      events.map((e) => e.name),
      events.map((e) => e.version ?? 1),
      events.map((e) => JSON.stringify(e.payload)),
      events.map((e) => e.requestId ?? null),
      events.map((e) => e.actorUserId ?? null),
      // `occurredAt` is left to the database where the caller did not supply one, so every
      // event in a transaction shares one clock — which is what makes per-organization relay
      // ordering mean anything.
      events.map((e) => e.occurredAt ?? null),
    ]);

    if (result.rows.length !== events.length) {
      // Reachable only if the INSERT silently dropped a row, which would mean side effects
      // vanished inside a committing transaction. Failing the transaction is the only safe
      // response.
      throw new InternalError(
        `Staged ${events.length} events but the outbox returned ${result.rows.length} ids.`,
      );
    }
    return result.rows.map((r) => r.id);
  }

  return {
    async stage(event) {
      const [id] = await stageAll([event]);
      if (id === undefined) throw new InternalError('The outbox returned no id for an event.');
      return id;
    },
    stageAll,
  };
}

/**
 * A publisher that refuses.
 *
 * For a code path that must NOT emit events — a read model, a migration tool — so "no
 * publisher was wired" fails loudly at the moment of the attempt instead of silently
 * swallowing a side effect. The alternative, a no-op publisher, is the bug it prevents.
 */
export const refusingPublisher: EventPublisher = {
  stage() {
    throw new InternalError('This code path has no event publisher and must not emit events.');
  },
  stageAll() {
    throw new InternalError('This code path has no event publisher and must not emit events.');
  },
};

/**
 * Sets `occurredAt` on every event in a batch so they share one instant.
 *
 * Used where events are built before the transaction opens. Without it, three events built in
 * a loop get three `now()` values and can relay out of the order the domain produced them.
 */
export const atOneInstant = (events: readonly DomainEvent[], at: Date): readonly DomainEvent[] =>
  events.map((event) => ({ ...event, occurredAt: at }));
