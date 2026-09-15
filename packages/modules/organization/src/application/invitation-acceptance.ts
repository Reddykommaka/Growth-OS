/**
 * Redeeming an invitation.
 *
 * Separate from creating one because the two have opposite starting points. Creation begins
 * with a resolved actor inside a tenant; acceptance begins with a stranger holding a string,
 * and must work out which tenant that string even refers to before it can read anything.
 */

import { hashToken, parseTenantToken } from '@growth-os/authn';
import { addressMatchesInvitation, invitationState } from '../domain/invitations.js';
import type {
  AuditSink,
  Clock,
  InvitationRow,
  RateLimiter,
  TenantScopedRepositories,
  TenantScopeFactory,
} from './ports.js';

export type AcceptOutcome =
  | {
      readonly outcome: 'accepted';
      readonly organizationId: string;
      readonly memberId: string;
      readonly roleSlug: string;
    }
  | {
      readonly outcome: 'failed';
      readonly reason:
        | 'invalid'
        | 'expired'
        | 'revoked'
        | 'already_accepted'
        | 'wrong_address'
        | 'already_a_member'
        | 'rate_limited';
    };

/**
 * Acceptance dependencies.
 *
 * Distinct from the inviter's, and the difference is the point: acceptance has no actor and
 * no tenant context, so it cannot be handed repositories that are already bound to one. It
 * receives a scope factory and opens the transaction itself, once the token has said which
 * tenant to open.
 */
export interface AcceptDependencies {
  readonly scope: TenantScopeFactory;
  readonly audit: AuditSink;
  readonly clock: Clock;
  readonly rateLimiter?: RateLimiter | undefined;
}

export interface AcceptInvitationInput {
  readonly token: string;
  /** The authenticated accepter. Both fields come from their session, not the request body. */
  readonly userId: string;
  readonly userEmail: string;
  readonly ip?: string | undefined;
}

/**
 * Accepts an invitation.
 *
 * The accepter supplies a token and their session. Everything that decides what access they
 * receive — which organization, which role, which workspace — comes from the stored row, so
 * there is no parameter for them to tamper with.
 *
 * The token names its own organization (ADR-0018), which is what makes the redemption
 * possible at all: `invitations` is tenant-scoped and its policy fails closed with no
 * context, so a lookup has to happen INSIDE a scope. That hint is untrusted, and it does not
 * need to be trusted — a token pointed at another organization opens a scope in which its
 * row is simply not visible, so "accepting an invitation for the wrong organization" fails
 * at the RLS policy rather than at a check that could be forgotten.
 *
 * Read, consume and admit all run in that one transaction. A crash between consuming the
 * invitation and writing the membership rolls back both.
 */
export async function acceptInvitation(
  deps: AcceptDependencies,
  input: AcceptInvitationInput,
): Promise<AcceptOutcome> {
  const hint = parseTenantToken(input.token);
  // Malformed and unknown are the same outcome: the format must not be an oracle.
  if (hint === undefined) return await refuse(deps, input, 'invalid', null);

  if (deps.rateLimiter !== undefined) {
    // Keyed by the organization the token names, so grinding tokens against one tenant is
    // bounded even when the presenter moves between addresses.
    const allowed = await deps.rateLimiter.consume(`accept:${hint.organizationId}`);
    if (!allowed) return await refuse(deps, input, 'rate_limited', null);
  }

  return await deps.scope.withoutWorkspaceReach(
    hint.organizationId,
    'invitation acceptance',
    async (repos) => await settleAcceptance(deps, repos, input),
  );
}

async function settleAcceptance(
  deps: AcceptDependencies,
  repos: TenantScopedRepositories,
  input: AcceptInvitationInput,
): Promise<AcceptOutcome> {
  const now = deps.clock.now();
  // The hash covers the WHOLE token, organization segment included, so a secret lifted from
  // one tenant's invitation does not hash to a stored value under any other.
  const row = await repos.invitations.findByTokenHash(hashToken(input.token));
  if (row === undefined) return await refuse(deps, input, 'invalid', null);

  const state = invitationState(row, now);
  if (state === 'revoked') return await refuse(deps, input, 'revoked', row);
  if (state === 'accepted') return await refuse(deps, input, 'already_accepted', row);
  if (state === 'expired') return await refuse(deps, input, 'expired', row);

  // A forwarded link is not an access grant to whoever opens it.
  if (!addressMatchesInvitation(row.email, input.userEmail)) {
    return await refuse(deps, input, 'wrong_address', row);
  }

  if (await repos.memberships.isMember(row.organizationId, input.userId)) {
    return await refuse(deps, input, 'already_a_member', row);
  }

  // Single-use, settled by the write. Two concurrent redemptions of one token race here and
  // exactly one wins; the loser creates no membership.
  if (!(await repos.invitations.consume(row.id, now))) {
    return await refuse(deps, input, 'already_accepted', row);
  }

  const role = await repos.roles.findById(row.roleId);
  if (role === undefined) return await refuse(deps, input, 'invalid', row);

  // Membership and the role assignment are created together. A member with no assignment has
  // joined an organization they cannot see, and the repair needs database access.
  const memberId = await repos.memberships.admit({
    organizationId: row.organizationId,
    userId: input.userId,
    memberType: row.memberType,
    roleId: row.roleId,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    invitedBy: row.invitedBy,
    at: now,
  });

  await deps.audit.record({
    action: 'organization.invitation.accepted',
    actorUserId: input.userId,
    organizationId: row.organizationId,
    resourceType: 'invitation',
    resourceId: row.id,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
    metadata: { role: role.slug, memberId },
  });

  return {
    outcome: 'accepted',
    organizationId: row.organizationId,
    memberId,
    roleSlug: role.slug,
  };
}

async function refuse(
  deps: AcceptDependencies,
  input: AcceptInvitationInput,
  reason: Extract<AcceptOutcome, { outcome: 'failed' }>['reason'],
  row: InvitationRow | null,
): Promise<AcceptOutcome> {
  await deps.audit.record({
    action: 'organization.invitation.acceptance_refused',
    actorUserId: input.userId,
    ...(row === null ? {} : { organizationId: row.organizationId }),
    resourceType: 'invitation',
    resourceId: row?.id ?? 'unknown',
    ...(input.ip === undefined ? {} : { ip: input.ip }),
    // The token never appears here, in any form.
    metadata: { reason },
  });
  return { outcome: 'failed', reason };
}
