/**
 * Reading and verifying the audit log.
 *
 * Audit records name who did what to whom, so reading them is itself a privileged action and
 * is guarded twice over:
 *
 *   1. `organization.audit_log:read`, asserted here. It is declared ORGANIZATION-scoped in
 *      the permission catalogue, so no workspace-scoped role — editor, contributor,
 *      client_guest — carries it, however the role is composed.
 *   2. Row-level security, which applies the tenant predicate AND the accessible-workspace
 *      set to any event tagged with a workspace.
 *
 * Neither replaces the other. The permission stops a client_guest asking; the policy means
 * that a bug in the permission layer still does not produce an answer.
 */

import type { AuditEventRecord, AuditReader, ChainVerification } from '@growth-os/audit';
import { genesisHash, verifyChain } from '@growth-os/audit';
import { type ActorContext, assertPermission } from '@growth-os/authz';
import { ForbiddenError } from '@growth-os/errors';

export interface AuditLogDependencies {
  readonly audit: AuditReader;
}

export interface ReadAuditLogInput {
  readonly workspaceId?: string | undefined;
  readonly actorUserId?: string | undefined;
  readonly action?: string | undefined;
  readonly resourceType?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly occurredFrom?: Date | undefined;
  readonly occurredTo?: Date | undefined;
  readonly limit?: number | undefined;
  readonly before?: number | undefined;
}

export interface AuditLogPage {
  readonly events: readonly AuditEventRecord[];
  readonly nextCursor?: number | undefined;
}

/**
 * Reads the organization's audit log.
 *
 * The organization is taken from the ACTOR, never from the caller. A request cannot name a
 * tenant: it reads the log of whichever organization the actor is acting in, which is the
 * same organization RLS will scope the query to.
 */
export async function readAuditLog(
  deps: AuditLogDependencies,
  actor: ActorContext,
  input: ReadAuditLogInput = {},
): Promise<AuditLogPage> {
  assertPermission(actor, 'organization.audit_log:read');

  // A workspace filter must name a workspace the actor can actually reach. Without this the
  // filter would simply return nothing (RLS would see to that), which reads as "no events
  // happened" rather than "you cannot see this" — an answer that invites the caller to
  // conclude the workspace is idle.
  if (
    input.workspaceId !== undefined &&
    !actor.accessibleWorkspaceIds.includes(input.workspaceId)
  ) {
    throw new ForbiddenError('That workspace is not available to you.', {
      cause: { reason: 'workspace_not_accessible', workspaceId: input.workspaceId },
    });
  }

  return await deps.audit.list({ organizationId: actor.organizationId, ...input });
}

export interface VerifyAuditLogResult extends ChainVerification {
  readonly from: number;
  readonly to: number;
}

/**
 * Verifies a slice of the organization's chain.
 *
 * Requires the same permission as reading, because verification returns event ids and
 * sequence numbers — less than the events themselves, but still a description of the log.
 *
 * A slice rather than the whole chain: a tenant's log does not fit in memory after a year,
 * and an operator checking integrity after an incident works forward from a known-good
 * point. `fromSequence` of 1 starts at the organization's genesis.
 */
export async function verifyAuditLog(
  deps: AuditLogDependencies,
  actor: ActorContext,
  fromSequence = 1,
  limit = 500,
): Promise<VerifyAuditLogResult> {
  assertPermission(actor, 'organization.audit_log:read');

  const events = await deps.audit.chainSlice(actor.organizationId, fromSequence, limit);
  const first = events[0];

  // Verifying a slice needs the link it should chain from. Starting at 1 means genesis;
  // starting anywhere else means the previous event's hash, which is carried by the first
  // event of the slice — and checking it against the recomputed chain is the point.
  const verification =
    fromSequence <= 1 || first === undefined
      ? verifyChain(actor.organizationId, events)
      : verifyChain(actor.organizationId, events, {
          startingAfter: { sequence: first.sequence - 1, hash: first.prevHash },
        });

  return {
    ...verification,
    from: first?.sequence ?? fromSequence,
    to: events.at(-1)?.sequence ?? fromSequence,
  };
}

/** The value an organization's chain must begin from. Exposed for operator tooling. */
export function auditGenesis(organizationId: string): Buffer {
  return genesisHash(organizationId);
}
