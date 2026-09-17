/**
 * Organization and workspace invitations.
 *
 * Every parameter that decides ACCESS — organization, role, scope — is read from the stored
 * invitation, never from the request that redeems it. The accepter supplies a token and
 * nothing else. That is what makes "modify the invitation parameters" a non-attack rather
 * than a control to be checked.
 */

import { randomUUID } from 'node:crypto';
import { userActor } from '@growth-os/audit';
import { issueTenantToken } from '@growth-os/authn';
import type { ActorContext } from '@growth-os/authz';
import { assertPermission, decide, type Permission } from '@growth-os/authz';
import { ConflictError, ForbiddenError, ValidationError } from '@growth-os/errors';
import {
  checkNoEscalation,
  INVITATION_TTL_MS,
  type InvitationScope,
  invitationState,
  memberTypeForRole,
  scopeMatchesRole,
} from '../domain/invitations.js';
import type {
  AuditSink,
  Clock,
  InvitationDelivery,
  InvitationNotifier,
  InvitationRepository,
  MembershipWriter,
  OrganizationReader,
  RateLimiter,
  RoleReader,
  RoleRecord,
} from './ports.js';

export interface InvitationDependencies {
  readonly invitations: InvitationRepository;
  readonly roles: RoleReader;
  readonly memberships: MembershipWriter;
  readonly audit: AuditSink;
  readonly clock: Clock;
  readonly rateLimiter?: RateLimiter | undefined;
  /** Supplied whenever there is a person to notify. See the port for why it is optional. */
  readonly notifier?: InvitationNotifier | undefined;
  readonly organizations?: OrganizationReader | undefined;
}

export interface CreateInvitationInput {
  /** The inviter's resolved context. Authority comes from here, never from the request. */
  readonly actor: ActorContext;
  readonly email: string;
  readonly roleSlug: string;
  readonly scope: InvitationScope;
}

export interface CreatedInvitation {
  readonly invitationId: string;
  /** Emailed to the invitee. Never logged, never returned over HTTP to anyone else. */
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Creates an invitation.
 *
 * Four independent checks, each sufficient to refuse:
 *   1. the inviter holds `organization.member:invite` IN THIS ORGANIZATION;
 *   2. for a workspace-scoped invitation, the inviter can reach that workspace;
 *   3. the role exists at the scope being granted;
 *   4. the role's permissions are a subset of the inviter's own.
 *
 * (4) is the one that is easy to omit and expensive to omit.
 */
export async function createInvitation(
  deps: InvitationDependencies,
  input: CreateInvitationInput,
): Promise<CreatedInvitation> {
  const { actor } = input;
  const now = deps.clock.now();

  if (deps.rateLimiter !== undefined) {
    const allowed = await deps.rateLimiter.consume(`invite:${actor.organizationId}`);
    // Bounded per organization, not per user: an attacker with one compromised account would
    // otherwise mail the whole address book from a domain the recipients trust.
    if (!allowed) throw new ValidationError('Too many invitations. Try again shortly.');
  }

  const role = await authorizeInvitation(deps, input);

  const email = input.email.trim();
  const existing = await deps.invitations.findPending(actor.organizationId, email);
  if (existing !== undefined) {
    throw new ConflictError('An invitation is already outstanding for that address.');
  }

  // The token carries the organization it belongs to, so the accepter — who has no tenant
  // context — can name the tenant whose scope to open. See ADR-0018.
  const { token, tokenHash } = issueTenantToken(actor.organizationId);
  const invitationId = randomUUID();
  await deps.invitations.create({
    id: invitationId,
    organizationId: actor.organizationId,
    email,
    roleId: role.id,
    ...(input.scope.kind === 'team' ? { teamId: input.scope.teamId } : {}),
    ...(input.scope.kind === 'workspace' ? { workspaceId: input.scope.workspaceId } : {}),
    memberType: memberTypeForRole(input.roleSlug),
    tokenHash,
    invitedBy: actor.userId ?? null,
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
  });

  // Inside the caller's transaction, so a delivery failure leaves NO invitation behind and
  // the inviter is told, rather than an unreachable row being created silently.
  await notify(deps, {
    invitationId,
    organizationId: actor.organizationId,
    email,
    token,
    roleSlug: input.roleSlug,
    invitedByUserId: actor.userId ?? null,
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    resent: false,
  });

  await deps.audit.record({
    action: 'organization.invitation.created',
    result: 'succeeded',
    actor: userActor(actor.userId ?? null),
    organizationId: actor.organizationId,
    resourceType: 'invitation',
    resourceId: invitationId,
    // Address and role, never the token.
    metadata: { email, role: input.roleSlug, scope: input.scope.kind },
  });

  return { invitationId, token, expiresAt: new Date(now.getTime() + INVITATION_TTL_MS) };
}

/**
 * The four checks, together.
 *
 * Extracted as one function because they are one decision — "may this inviter grant this?" —
 * and because a caller that performed three of them would look correct. Returns the role
 * only if all four pass, so there is no way to reach the write without having asked.
 */
async function authorizeInvitation(
  deps: InvitationDependencies,
  input: CreateInvitationInput,
): Promise<RoleRecord> {
  const { actor } = input;

  // (1) Server-side, from the resolved actor. A client-supplied organization id is never
  // consulted — the actor's own context decides which tenant this is.
  assertPermission(actor, 'organization.member:invite');

  // (2) A workspace-scoped invitation is an access grant to that workspace, so the inviter
  // must be able to reach it. Without this, any member with the invite permission could
  // staff a client they have no relationship with.
  if (input.scope.kind === 'workspace') {
    const decision = decide(actor, 'organization.role_assignment:grant', {
      type: 'workspace',
      id: input.scope.workspaceId,
      workspaceId: input.scope.workspaceId,
    });
    if (!decision.allowed) {
      throw new ForbiddenError('You do not have permission to invite into that workspace.', {
        cause: { reason: decision.reason, workspaceId: input.scope.workspaceId },
      });
    }
  }

  const role = await deps.roles.findAssignableRole(actor.organizationId, input.roleSlug);
  if (role === undefined) throw new ValidationError('That role does not exist.');

  // (3) A role granted at the wrong scope produces an assignment the engine never matches:
  // it looks like access was granted and grants nothing.
  if (!scopeMatchesRole(role.scope, input.scope)) {
    throw new ValidationError(
      `The ${input.roleSlug} role is granted at ${role.scope} scope, not ${input.scope.kind}.`,
    );
  }

  // (4) THE ESCALATION CHECK.
  const verdict = checkNoEscalation(effectivePermissions(actor), role.permissions);
  if (!verdict.allowed) {
    await deps.audit.record({
      action: 'organization.invitation.escalation_refused',
      result: 'denied',
      actor: userActor(actor.userId ?? null),
      organizationId: actor.organizationId,
      resourceType: 'invitation',
      resourceId: input.roleSlug,
      // The missing permissions go to the audit log, not to the caller: enumerating what an
      // inviter lacks maps the role model for them one attempt at a time.
      metadata: { role: input.roleSlug, missingCount: verdict.missing.length },
    });
    throw new ForbiddenError('You cannot grant access beyond your own.', {
      cause: { reason: verdict.reason, missing: verdict.missing },
    });
  }

  return role;
}

/** The permissions an actor actually holds right now, flattened from live assignments. */
function effectivePermissions(actor: ActorContext): readonly Permission[] {
  const now = Date.now();
  const held = new Set<Permission>();
  for (const assignment of actor.assignments) {
    if (assignment.expiresAt !== undefined && assignment.expiresAt.getTime() <= now) continue;
    for (const permission of assignment.permissions) held.add(permission);
  }
  return [...held];
}

/** Revokes an outstanding invitation. Requires the same permission as creating one. */
export async function revokeInvitation(
  deps: InvitationDependencies,
  actor: ActorContext,
  invitationId: string,
): Promise<boolean> {
  assertPermission(actor, 'organization.member:invite');
  const now = deps.clock.now();
  // Scoped to the actor's own organization, so an id from another tenant finds nothing.
  const revoked = await deps.invitations.revoke(actor.organizationId, invitationId, now);
  if (revoked) {
    await deps.audit.record({
      action: 'organization.invitation.revoked',
      result: 'succeeded',
      actor: userActor(actor.userId ?? null),
      organizationId: actor.organizationId,
      resourceType: 'invitation',
      resourceId: invitationId,
    });
  }
  return revoked;
}

/**
 * Re-sends an invitation.
 *
 * Issues a NEW token and invalidates the old one, rather than re-mailing the existing link.
 * Three "resend" clicks would otherwise leave three live tokens, each an independent chance
 * for an intercepted message to be redeemed weeks later.
 */
export async function resendInvitation(
  deps: InvitationDependencies,
  actor: ActorContext,
  invitationId: string,
): Promise<CreatedInvitation | undefined> {
  assertPermission(actor, 'organization.member:invite');
  const now = deps.clock.now();
  const row = await deps.invitations.findById(actor.organizationId, invitationId);
  if (row === undefined || invitationState(row, now) !== 'pending') return undefined;

  const { token, tokenHash } = issueTenantToken(actor.organizationId);
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
  const role = await deps.roles.findById(row.roleId);

  // Pinned to the token that was read. A concurrent resend, acceptance or revocation makes
  // this a no-op, and the caller is told rather than mailing a link that is already dead.
  if (!(await deps.invitations.rotateToken(row.id, row.tokenHash, tokenHash, expiresAt, now))) {
    return undefined;
  }

  await notify(deps, {
    invitationId: row.id,
    organizationId: actor.organizationId,
    email: row.email,
    token,
    roleSlug: role?.slug ?? 'unknown',
    invitedByUserId: actor.userId ?? null,
    expiresAt,
    resent: true,
  });

  await deps.audit.record({
    action: 'organization.invitation.resent',
    result: 'succeeded',
    actor: userActor(actor.userId ?? null),
    organizationId: actor.organizationId,
    resourceType: 'invitation',
    resourceId: row.id,
  });
  return { invitationId: row.id, token, expiresAt };
}

/**
 * Hands the token to the notifier, and to nothing else.
 *
 * A no-op when no notifier is configured, which is the correct behaviour rather than an
 * error: an invitation created by a back-office tool has nobody to mail. The organization
 * name is looked up here rather than threaded through every caller, and a missing name is
 * not a reason to refuse — the invitation is still valid.
 */
async function notify(
  deps: InvitationDependencies,
  delivery: Omit<InvitationDelivery, 'organizationName'>,
): Promise<void> {
  if (deps.notifier === undefined) return;
  const name = (await deps.organizations?.nameOf(delivery.organizationId)) ?? '';
  await deps.notifier.deliver({ ...delivery, organizationName: name });
}
