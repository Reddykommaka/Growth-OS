/**
 * @growth-os/events — the transactional event spine.
 *
 * ADR-0007. A domain write and its side effects commit together or not at all: the event is
 * INSERTed into `outbox_events` inside the caller's transaction, and a relay publishes it
 * afterwards. Nothing here opens a transaction of its own, because a writer that did would be
 * the dual-write bug the outbox exists to remove.
 */
export { assertPublishable, type DomainEvent } from './event.js';
export {
  atOneInstant,
  createOutboxPublisher,
  type EventPublisher,
  type Queryable,
  refusingPublisher,
} from './outbox.js';
export {
  type EventSink,
  type OutboxLag,
  RELAY_LOCK_SEED,
  type RelayOptions,
  type RelayPass,
  type RelayQueryable,
  type RelayTransactor,
  readOutboxLag,
  relayOnce,
  type StagedEvent,
  tryClaimOrganization,
} from './relay.js';
