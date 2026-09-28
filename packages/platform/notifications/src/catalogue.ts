/**
 * The notification type catalogue.
 *
 * In code, not in a table — the same decision as the permission and capability catalogues, for
 * the same reason: the set of things the software can tell someone about is a property of the
 * software. A table that could disagree with the code about which types exist would show up as
 * a notification nothing knows how to render, or a type nothing sends.
 *
 * The catalogue is also what makes the notifications table's wide WRITE rule tolerable. RLS has
 * to permit notifying somebody else — that is the entire operation — so a member can put a row
 * in another member's inbox. What stops that being a phishing primitive is that the type decides
 * what the notification SAYS: the payload is interpolated into a template declared here, never
 * rendered as free text.
 */

/** Where a notification can go. In-app is not a channel: it is the inbox row itself. */
export type Channel = 'email';

export interface NotificationType {
  readonly key: string;
  readonly module: string;
  /**
   * Whether an inbox row is written.
   *
   * False for a type whose recipient has no account yet — an invitation is addressed to an
   * email address precisely because there is nobody to give an inbox row to.
   */
  readonly inApp: boolean;
  readonly channels: readonly Channel[];
  /**
   * Whether the recipient may turn this off.
   *
   * Some notifications are not a preference. "Your password was changed" and "a new device
   * signed in" are security notices: an attacker who has taken an account would otherwise
   * silence the one message that reveals it. Recorded per type so the answer is a reviewed
   * property rather than a switch someone forgot to exclude.
   */
  readonly mandatory: boolean;
  readonly description: string;
}

const type = (
  key: string,
  module: string,
  inApp: boolean,
  channels: readonly Channel[],
  mandatory: boolean,
  description: string,
): NotificationType => ({ key, module, inApp, channels, mandatory, description });

const TYPES: readonly NotificationType[] = [
  // ---- organization -------------------------------------------------------------------
  type(
    'organization.invitation.sent',
    'organization',
    // No inbox row: the recipient has no account. This is the type that forced the outbound
    // queue to be addressable by channel rather than by user.
    false,
    ['email'],
    true,
    'An invitation to join an organization, carrying its single-use link.',
  ),
  type(
    'organization.invitation.accepted',
    'organization',
    true,
    ['email'],
    false,
    'Someone accepted an invitation you sent.',
  ),
  type(
    'organization.member.removed',
    'organization',
    true,
    ['email'],
    true,
    'Your membership of an organization ended.',
  ),
  type(
    'organization.role.changed',
    'organization',
    true,
    ['email'],
    true,
    'Your role in an organization changed. Mandatory: a silent privilege change is exactly what an attacker wants.',
  ),
  // ---- identity -----------------------------------------------------------------------
  type(
    'identity.password.changed',
    'identity',
    true,
    ['email'],
    true,
    'Your password was changed. Mandatory: it is the message that reveals a stolen account.',
  ),
  type(
    'identity.mfa.changed',
    'identity',
    true,
    ['email'],
    true,
    'Two-factor authentication was enabled, disabled or re-enrolled on your account.',
  ),
  type(
    'identity.session.new_device',
    'identity',
    true,
    ['email'],
    true,
    'A sign-in from a device this account has not used before.',
  ),
  type(
    'identity.api_key.created',
    'identity',
    true,
    ['email'],
    true,
    'An API key was created in your organization. Mandatory: a key is a credential.',
  ),
  // ---- billing ------------------------------------------------------------------------
  type(
    'billing.payment.failed',
    'billing',
    true,
    ['email'],
    true,
    'A payment failed. Mandatory: the consequence of ignoring it is losing service.',
  ),
  type(
    'billing.subscription.changed',
    'billing',
    true,
    ['email'],
    false,
    'The organization plan changed.',
  ),
  type(
    'billing.limit.reached',
    'billing',
    true,
    [],
    false,
    'An entitlement limit was reached. In-app only: it is actionable where the work is, and an email per limit hit would be noise.',
  ),
  // ---- social -------------------------------------------------------------------------
  type('social.post.published', 'social', true, [], false, 'A scheduled post went out.'),
  type(
    'social.post.failed',
    'social',
    true,
    ['email'],
    false,
    'A scheduled post could not be published.',
  ),
  type(
    'social.connection.degraded',
    'social',
    true,
    ['email'],
    false,
    'A connected account needs re-authorization. Emailed because nothing publishes until it is fixed.',
  ),
  // ---- marketing ----------------------------------------------------------------------
  type(
    'marketing.campaign.completed',
    'marketing',
    true,
    [],
    false,
    'A campaign finished sending.',
  ),
  type(
    'marketing.campaign.failed',
    'marketing',
    true,
    ['email'],
    false,
    'A campaign stopped before completing.',
  ),
  // ---- marketplace --------------------------------------------------------------------
  type(
    'marketplace.order.placed',
    'marketplace',
    true,
    ['email'],
    false,
    'An order was placed against one of your listings.',
  ),
  type(
    'marketplace.payout.sent',
    'marketplace',
    true,
    ['email'],
    true,
    'A payout was sent. Mandatory: it is money leaving, and the recipient must be able to reconcile it.',
  ),
  // ---- platform -----------------------------------------------------------------------
  type(
    'platform.export.ready',
    'platform',
    true,
    ['email'],
    false,
    'An export you requested is ready to download.',
  ),
  type(
    'platform.automation.failed',
    'platform',
    true,
    ['email'],
    false,
    'An automation run failed and will not retry.',
  ),
];

const BY_KEY = new Map(TYPES.map((t) => [t.key, t]));

export function notificationType(key: string): NotificationType | undefined {
  return BY_KEY.get(key);
}

export function notificationTypeKeys(): readonly string[] {
  return TYPES.map((t) => t.key);
}

/** Keys that are not in the catalogue. Empty means every key given is declared. */
export function unknownNotificationTypes(keys: readonly string[]): readonly string[] {
  return [...new Set(keys.filter((key) => !BY_KEY.has(key)))].sort();
}
