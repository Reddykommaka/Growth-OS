/**
 * The production `InvitationNotifier`.
 *
 * Until now the port had no implementation and an invitation was created with nothing to deliver
 * it. What made that gap awkward to close is the token: it exists only in memory, because
 * ADR-0018 stores its hash and never the secret, so the message has to be RENDERED inside the
 * transaction that created the invitation even though it must be SENT long afterwards.
 *
 * Three routes were possible and two are wrong:
 *
 *   1. Send the mail inline. Refused by 01-overview.md §4 — no third-party call inside a
 *      transaction — and it is the dual-write bug besides: a sent invitation with a rolled-back
 *      row, or a committed row whose mail never went.
 *
 *   2. Put the token on the outbox event. REFUSED, and this is the one that matters:
 *      `outbox_events` is readable by every session in the organization under its policy, so any
 *      member could lift another member's invitation token out of the queue and accept in their
 *      place. @growth-os/events rejects a payload carrying a token for exactly this reason.
 *
 *   3. Render here, seal with a key the database never holds, and queue. The application role may
 *      INSERT into `outbound_messages` and may not SELECT, so the row this writes is one it
 *      cannot read back. That is the route.
 *
 * `deliver` therefore returns having written a COMMITTED INTENT TO SEND, not a delivery — which
 * is why the port returns void rather than a receipt.
 */
import type { NotificationService, NotifyResult, Queryable } from '@growth-os/notifications';
import type { InvitationDelivery, InvitationNotifier } from '../application/index.js';

export interface InvitationNotifierDependencies {
  readonly notifications: NotificationService;
  /**
   * Where the acceptance link points. From configuration, never from a request.
   *
   * A caller-supplied base URL in an invitation mail is a phishing primitive: the message is
   * legitimate, carries a real token, and points wherever the caller chose.
   */
  readonly appBaseUrl: string;
  /** Replies go somewhere a human reads, not to the invited address. */
  readonly replyTo?: string | undefined;
}

/**
 * The acceptance URL.
 *
 * The token is placed in the path rather than the query string. Query strings are logged by
 * proxies and CDNs far more often than paths, and are forwarded in `Referer` headers when the
 * landing page loads a third-party asset — which for a single-use credential means the credential
 * leaves the recipient's browser.
 */
function acceptanceUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, '')}/invitations/${encodeURIComponent(token)}/accept`;
}

const ONE_HOUR_MS = 3_600_000;

/** "in 3 days" reads better than a timestamp in a mail, and is timezone-free. */
function expiresIn(expiresAt: Date, now: Date): string {
  const hours = Math.max(Math.round((expiresAt.getTime() - now.getTime()) / ONE_HOUR_MS), 0);
  if (hours < 1) return 'less than an hour';
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours / 24)} days`;
}

function renderBody(delivery: InvitationDelivery, url: string, now: Date): string {
  const lines = [
    `You have been invited to join ${delivery.organizationName} on Growth OS`,
    `as ${delivery.roleSlug}.`,
    '',
    'Open this link to accept:',
    url,
    '',
    `The link expires in ${expiresIn(delivery.expiresAt, now)} and can be used once.`,
  ];
  if (delivery.resent) {
    // Said explicitly because the previous token was revoked when this one was issued. Without
    // this line, a recipient who kept the first mail sees only that its link stopped working.
    lines.push('', 'This replaces an earlier invitation. Any previous link no longer works.');
  }
  lines.push(
    '',
    'If you were not expecting this, you can ignore this message — the link only works',
    'for this email address, and nothing happens until you use it.',
  );
  return lines.join('\n');
}

export function createInvitationNotifier(
  deps: InvitationNotifierDependencies,
  /**
   * The transaction the invitation is being created in.
   *
   * Passed rather than opened, so the queued message and the invitation row commit together. A
   * notifier that opened its own connection could queue a message for an invitation that then
   * rolled back — a live link to an invitation that does not exist.
   */
  client: Queryable,
  now: () => Date = () => new Date(),
): InvitationNotifier {
  return {
    async deliver(delivery: InvitationDelivery): Promise<void> {
      const at = now();
      const url = acceptanceUrl(deps.appBaseUrl, delivery.token);

      const result: NotifyResult = await deps.notifications.notify(client, {
        organizationId: delivery.organizationId,
        type: 'organization.invitation.sent',
        actorUserId: delivery.invitedByUserId,
        envelope: {
          to: delivery.email,
          subject: `Join ${delivery.organizationName} on Growth OS`,
          body: renderBody(delivery, url, at),
          ...(deps.replyTo === undefined ? {} : { replyTo: deps.replyTo }),
        },
        /*
         * The inbox payload carries the invitation's IDENTITY and no content.
         *
         * `organization.invitation.sent` writes no inbox row — the recipient has no account — so
         * this payload exists only to reach the domain event, which every session in the
         * organization can read. The token, the address and the rendered text all stay inside the
         * sealed envelope.
         */
        payload: { invitationId: delivery.invitationId, resent: delivery.resent },
      });

      if (result.messageIds.length === 0) {
        // Reachable only if the catalogue entry lost its email channel, which would mean
        // invitations silently stopped being delivered while every test about creating them still
        // passed. Failing the transaction is the only outcome that surfaces it.
        throw new Error(
          'organization.invitation.sent queued no message. An invitation that is created ' +
            'without being sent is worse than one that fails to be created.',
        );
      }
    },
  };
}
