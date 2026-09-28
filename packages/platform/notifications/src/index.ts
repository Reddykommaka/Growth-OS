/**
 * @growth-os/notifications — the channel-agnostic notification service.
 *
 * Two halves, deliberately separate (migration 0016):
 *
 *   `notifications`      an in-app row for a user who already exists. Personal: the policy
 *                        confines every read to `recipient_user_id = app_current_user_id()`.
 *   `outbound_messages`  a rendered, SEALED message for a channel address, which may belong to
 *                        nobody — an invitation is sent to an address precisely because there is
 *                        no account yet. The application role may INSERT and not SELECT, so a
 *                        tenant stages a message carrying a token it cannot read back.
 *
 * Nothing here sends anything, and nothing here opens a transaction. `notify` writes against the
 * caller's transaction so the inbox row, the queued message and the domain event commit together
 * or not at all; `sendOnce` is the worker's half.
 */
export {
  type Channel,
  type NotificationType,
  notificationType,
  notificationTypeKeys,
  unknownNotificationTypes,
} from './catalogue.js';
export {
  assertDeliverable,
  type MessageEnvelope,
  openEnvelope,
  sealEnvelope,
} from './envelope.js';
export {
  countUnread,
  dismiss,
  type InboxEntry,
  type InboxPage,
  type InboxQuery,
  markAllRead,
  markRead,
  readInbox,
} from './inbox.js';
export type { Clock, EventStager, IdGenerator, MessageCipher, Queryable } from './ports.js';
export {
  type MessageChannel,
  type OutboundLag,
  type OutboundMessage,
  readOutboundLag,
  type SenderOptions,
  type SenderPass,
  type SenderQueryable,
  type SenderTransactor,
  sendOnce,
} from './sender.js';
export {
  createNotificationService,
  type NotificationDependencies,
  type NotificationService,
  type NotifyInput,
  type NotifyResult,
} from './service.js';
