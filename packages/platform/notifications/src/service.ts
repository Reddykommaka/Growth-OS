/**
 * The notification service.
 *
 * ONE OPERATION, THREE WRITES, ONE TRANSACTION. `notify` writes the inbox row, queues the
 * outbound messages and stages the domain event, all against the caller's open transaction. None
 * of them may commit without the others: an inbox row with no email is a notification the user
 * never learns about, and an email with no inbox row is one they cannot find again.
 *
 * NOTHING IS SENT HERE. 01-overview.md §4 forbids a third-party call inside a transaction, and
 * the queue is what defers it. What this module produces is a *committed intent to send*; the
 * worker turns that into a delivery.
 *
 * THE TOKEN PROBLEM, which is the reason this package is shaped the way it is. An invitation mail
 * must carry a single-use token that exists only in memory (ADR-0018 stores its hash). It cannot
 * ride on the outbox event — `outbox_events` is readable by every session in the organization, so
 * any member could lift another member's invitation token out of the queue. So the rendered text
 * goes into `outbound_messages` sealed with a key the database never holds, the application role
 * may INSERT and not SELECT, and the event carries only the row's id.
 */
import { ValidationError } from '@growth-os/errors';
import { type NotificationType, notificationType } from './catalogue.js';
import { type MessageEnvelope, sealEnvelope } from './envelope.js';
import type { Clock, EventStager, IdGenerator, MessageCipher, Queryable } from './ports.js';

export interface NotificationDependencies {
  readonly cipher: MessageCipher;
  readonly events: EventStager;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface NotifyInput {
  readonly organizationId: string;
  readonly workspaceId?: string | null | undefined;
  readonly type: string;
  /**
   * The inbox recipient. Absent for a type with `inApp: false`, whose recipient has no account —
   * which is the whole reason the outbound queue is addressed by channel rather than by user.
   */
  readonly recipientUserId?: string | undefined;
  /** Who caused it. Null means the system, not "unknown". */
  readonly actorUserId?: string | null | undefined;
  /** Rendered by the caller, because only the caller knows the domain. Sealed here. */
  readonly envelope?: MessageEnvelope | undefined;
  /** Interpolated into the in-app rendering. Must not carry a secret; see `assertInboxSafe`. */
  readonly payload?: Readonly<Record<string, unknown>> | undefined;
  readonly requestId?: string | null | undefined;
}

export interface NotifyResult {
  /** Null when the type writes no inbox row. */
  readonly notificationId: string | null;
  /** One per channel queued. Empty when the type has no channels. */
  readonly messageIds: readonly string[];
  readonly eventId: string;
}

/*
 * NO `RETURNING id` HERE EITHER, and for a sharper reason than on the queue below.
 *
 * PostgreSQL applies the SELECT policy to an INSERT's RETURNING clause. The notifications policy
 * confines reads to `recipient_user_id = app_current_user_id()`, and notifying somebody else is
 * the entire operation — so `RETURNING id` fails for every notification that is not addressed to
 * the session writing it. The id is therefore generated before the statement, exactly as for
 * `outbound_messages`, and for the same underlying reason: a row this session may write is not a
 * row it may read.
 */
const INSERT_NOTIFICATION = `
  INSERT INTO notifications
    (id, organization_id, workspace_id, recipient_user_id, actor_user_id, type, payload)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`;

/*
 * No RETURNING, and the id is supplied.
 *
 * `INSERT ... RETURNING` requires SELECT on the table, and withholding SELECT from the
 * application role is the entire point of this table's grants: a session stages a message
 * containing a token it cannot read back. So the id is generated before the statement.
 */
const INSERT_MESSAGE = `
  INSERT INTO outbound_messages (id, organization_id, workspace_id, channel, envelope, type)
  VALUES ($1, $2, $3, $4, $5, $6)`;

/**
 * The inbox payload may not carry a secret either.
 *
 * Weaker than the event check and for a weaker reason — the inbox row stays inside the database
 * under a policy — but it is rendered into a page and a page is screenshotted, cached and pasted
 * into support tickets. A notification says a thing happened; it never needs the credential.
 */
const FORBIDDEN_PAYLOAD_KEY =
  /password|secret|(?<!api_?key_?id)token|api[_-]?key(?!_?id)|credential|mfa|totp|recovery[_-]?code/i;

function assertInboxSafe(type: string, payload: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_PAYLOAD_KEY.test(key)) {
      throw new ValidationError(
        `Notification ${type} carries a forbidden payload key "${key}". A notification says ` +
          'that something happened; it never needs the credential involved.',
      );
    }
  }
}

export interface NotificationService {
  notify(client: Queryable, input: NotifyInput): Promise<NotifyResult>;
}

/**
 * Everything that must hold before anything is written.
 *
 * Separated from the writes so `notify` reads as the three statements it is. Each of these is a
 * programming error rather than a denial — a type nothing renders, an inbox row with no recipient,
 * a channelled type with nothing to send — so each fails the transaction rather than degrading to
 * a partial notification, which would be a notification nobody receives and nobody notices.
 */
function resolveType(input: NotifyInput): NotificationType {
  const declared = notificationType(input.type);
  if (declared === undefined) {
    throw new ValidationError(`Unknown notification type: ${input.type}`);
  }
  assertInboxSafe(declared.key, input.payload ?? {});

  if (declared.inApp && input.recipientUserId === undefined) {
    throw new ValidationError(
      `Notification ${declared.key} writes an inbox row and needs a recipient user.`,
    );
  }
  if (declared.channels.length > 0 && input.envelope === undefined) {
    throw new ValidationError(
      `Notification ${declared.key} has channels ${declared.channels.join(', ')} and needs ` +
        'a rendered envelope.',
    );
  }
  return declared;
}

export function createNotificationService(deps: NotificationDependencies): NotificationService {
  return {
    async notify(client, input) {
      const declared = resolveType(input);
      const payload = input.payload ?? {};

      let notificationId: string | null = null;
      if (declared.inApp && input.recipientUserId !== undefined) {
        notificationId = deps.ids.next();
        await client.query(INSERT_NOTIFICATION, [
          notificationId,
          input.organizationId,
          input.workspaceId ?? null,
          input.recipientUserId,
          input.actorUserId ?? null,
          declared.key,
          JSON.stringify(payload),
        ]);
      }

      const messageIds: string[] = [];
      if (input.envelope !== undefined) {
        // Sealed ONCE per notification, not once per channel: the ciphertext is identical and a
        // fresh GCM nonce per channel would only make two rows that cannot be compared.
        const sealed = sealEnvelope(deps.cipher, input.envelope);
        for (const channel of declared.channels) {
          const id = deps.ids.next();
          await client.query(INSERT_MESSAGE, [
            id,
            input.organizationId,
            input.workspaceId ?? null,
            channel,
            sealed,
            declared.key,
          ]);
          messageIds.push(id);
        }
      }

      /*
       * The event carries IDS AND NOTHING ELSE.
       *
       * It names what happened and where the content is. It deliberately does not carry the
       * subject, the body or the address: the event is readable by every session in the
       * organization, and the content is the thing being protected.
       */
      const eventId = await deps.events.stage({
        name: 'platform.notification.queued',
        organizationId: input.organizationId,
        workspaceId: input.workspaceId ?? null,
        payload: {
          notificationType: declared.key,
          notificationId,
          messageIds,
          channels: declared.channels,
        },
        requestId: input.requestId ?? null,
        actorUserId: input.actorUserId ?? null,
      });

      return { notificationId, messageIds, eventId };
    },
  };
}
