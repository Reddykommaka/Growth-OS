/**
 * Invitation rules.
 *
 * Pure decisions over facts the caller has established, so the escalation cases are
 * enumerable without a database.
 *
 * THE RULE THIS FILE EXISTS FOR: an inviter may never grant access they do not themselves
 * hold. Without it, `organization.member:invite` is a silent promotion to `owner` — an admin
 * invites a throwaway address as owner, accepts it, and now holds every permission including
 * the ones the real owner used to bound them. The permission to invite is common; the
 * permission to create someone more powerful than yourself is not, and nothing in RBAC
 * distinguishes them unless this check does.
 */
import type { Permission } from '@growth-os/authz';

export type InvitationScope =
  | { readonly kind: 'organization' }
  | { readonly kind: 'team'; readonly teamId: string }
  | { readonly kind: 'workspace'; readonly workspaceId: string };

export type EscalationVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'privilege_escalation';
      /** Exactly what the inviter lacks. Logged, never returned — see the service. */
      readonly missing: readonly Permission[];
    };

/**
 * Whether an inviter may grant this role.
 *
 * Set containment, not role ranking. A ranking ("admin < owner") is a second model that has
 * to be kept in step with the permission sets, and the moment it drifts the check passes
 * while the escalation happens. Comparing the actual permissions cannot drift, because it is
 * the same data the authorization engine decides on.
 */
export function checkNoEscalation(
  inviterPermissions: readonly Permission[],
  rolePermissions: readonly Permission[],
): EscalationVerdict {
  const held = new Set<string>(inviterPermissions);
  const missing = rolePermissions.filter((p) => !held.has(p));
  return missing.length === 0
    ? { allowed: true }
    : { allowed: false, reason: 'privilege_escalation', missing };
}

export type InvitationState = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface InvitationFacts {
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
}

/**
 * Classifies an invitation.
 *
 * Revocation is checked BEFORE expiry, for the same reason session revocation is: an
 * invitation withdrawn because the person left is withdrawn now, and reporting it as merely
 * "expired" would suggest re-sending it.
 */
export function invitationState(facts: InvitationFacts, now: Date): InvitationState {
  if (facts.revokedAt !== null && facts.revokedAt <= now) return 'revoked';
  if (facts.acceptedAt !== null) return 'accepted';
  if (facts.expiresAt <= now) return 'expired';
  return 'pending';
}

/** Seven days. Long enough to survive a holiday, short enough that a stale link dies. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether the accepting user's address must match the invited one.
 *
 * It must, always, and the reason is narrow: the invitation grants access to a specific
 * organization, and the person who was asked is the person named. If any signed-in user
 * could redeem any link they obtained, a forwarded email — or a link pasted into a shared
 * channel — becomes an access grant to whoever reads it first.
 *
 * Compared case-insensitively because the column is citext and the addresses are the same
 * mailbox; trimmed because a pasted address carries whitespace.
 */
export function addressMatchesInvitation(invitedEmail: string, accepterEmail: string): boolean {
  return invitedEmail.trim().toLowerCase() === accepterEmail.trim().toLowerCase();
}

/**
 * The member type an invited role implies.
 *
 * `client_guest` is held by someone outside the tenant organization, so the membership it
 * creates is a client membership rather than staff — which is what keeps the agency's own
 * member lists, seat counts and internal notifications free of client reviewers.
 */
export function memberTypeForRole(roleSlug: string): 'staff' | 'client' {
  return roleSlug === 'client_guest' ? 'client' : 'staff';
}

/**
 * Whether the scope a role is being granted at is legal for that role.
 *
 * A role declares the scope it exists at; granting it elsewhere produces an assignment the
 * authorization engine will never match, which is worse than an error — it looks like access
 * was granted and silently grants nothing.
 */
export function scopeMatchesRole(roleScope: string, scope: InvitationScope): boolean {
  switch (scope.kind) {
    case 'organization':
      return roleScope === 'organization';
    case 'team':
      return roleScope === 'team';
    case 'workspace':
      return roleScope === 'workspace';
    default: {
      const unreachable: never = scope;
      return unreachable;
    }
  }
}
