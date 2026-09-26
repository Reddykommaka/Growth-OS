/**
 * The domain event, and what makes one publishable.
 *
 * An event is a STATEMENT OF FACT about something that has already happened, named in the
 * past tense, belonging to one organization. That is not stylistic: a consumer may run
 * minutes after the fact, on a different process, after a retry — so an event phrased as an
 * instruction ("publish this post") is a command that has already been obeyed or will be
 * obeyed twice, whereas an event phrased as a fact ("this post was published") is safe to
 * observe any number of times.
 */
import { ValidationError } from '@growth-os/errors';

/**
 * The name shape every event must satisfy: `<module>.<aggregate>.<pastTenseVerb>`.
 *
 * Enforced rather than encouraged. The relay routes on the name and the automation engine
 * binds triggers to it, so a name is a wire contract; `postPublished` and
 * `social.post.publish` would each work until something tried to subscribe to a family of
 * events by prefix.
 */
const EVENT_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*){2,}$/;

export interface DomainEvent {
  readonly name: string;
  /**
   * Bumped when the payload's shape changes incompatibly. A separate column from the name so
   * one consumer can handle two versions during a rolling deploy — which is the only reason
   * a payload change is deployable at all.
   */
  readonly version?: number | undefined;
  readonly organizationId: string;
  readonly workspaceId?: string | null | undefined;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly requestId?: string | null | undefined;
  readonly actorUserId?: string | null | undefined;
  /**
   * When the fact became true, if that is not now.
   *
   * Supplied only where the domain genuinely knows better — a metric observed at a provider's
   * timestamp. Left unset otherwise, so the database's `now()` inside the transaction is the
   * single clock, which is what keeps per-organization relay ordering meaningful.
   */
  readonly occurredAt?: Date | undefined;
}

/**
 * Payload keys that must never be carried on an event.
 *
 * An event is published to a queue, persisted in Redis, logged by consumers and replayed from
 * a dead-letter queue by a human. Anything on it has left the transaction's blast radius
 * entirely. The audit log redacts the same classes for the same reason; the difference is that
 * here the leak is into infrastructure a tenant's data has no business reaching.
 */
const FORBIDDEN_KEY =
  /password|secret|token|api[_-]?key|private[_-]?key|credential|authorization|mfa|totp|recovery[_-]?code|session[_-]?id|cookie/i;

/** A key that merely REFERENCES a secret by identity, and is therefore safe to carry. */
const REFERENCE_ONLY = /^(?:api_?key_?id|token_?hash|session_?token_?hash)$/i;

function assertPayloadCarriesNoSecrets(name: string, payload: object, path = ''): void {
  for (const [key, value] of Object.entries(payload)) {
    const here = path === '' ? key : `${path}.${key}`;
    if (FORBIDDEN_KEY.test(key) && !REFERENCE_ONLY.test(key)) {
      throw new ValidationError(
        `Event ${name} carries a forbidden payload key at ${here}. An event reaches Redis, ` +
          'consumer logs and the dead-letter queue, so it may carry an identifier for a ' +
          'secret but never the secret itself.',
      );
    }
    if (value !== null && typeof value === 'object') {
      assertPayloadCarriesNoSecrets(name, value, here);
    }
  }
}

/**
 * Validates an event before it can be staged.
 *
 * Throws rather than returning a result: an invalid event inside a domain transaction is a
 * programming error, and the transaction that would have carried it must not commit. Silently
 * dropping it would produce exactly the outcome the outbox exists to prevent — a state change
 * with no side effect.
 */
export function assertPublishable(event: DomainEvent): void {
  if (!EVENT_NAME.test(event.name)) {
    throw new ValidationError(
      `Invalid event name "${event.name}". Events are named ` +
        '<module>.<aggregate>.<pastTenseVerb>, lowercase, because the name is a wire ' +
        'contract the relay routes on and the automation engine binds triggers to.',
    );
  }
  if ((event.version ?? 1) < 1 || !Number.isInteger(event.version ?? 1)) {
    throw new ValidationError(`Event ${event.name} has a non-integer or non-positive version.`);
  }
  if (event.organizationId.length === 0) {
    throw new ValidationError(`Event ${event.name} has no organization.`);
  }
  assertPayloadCarriesNoSecrets(event.name, event.payload);
}
