/**
 * Granting and revoking entitlement overrides.
 *
 * An override is how an enterprise deal is honoured without inventing a plan per customer —
 * and, in the other direction, how a capability is withdrawn from one customer without
 * moving them off their plan. Both are commercial acts with security consequences, so both
 * are permission-checked and both are audited.
 *
 * WHY `billing.subscription:manage` GATES THIS. An override changes what the organization
 * has bought, which is the same authority as changing its subscription — held by `owner`,
 * `admin` and `billing`, and by no workspace-scoped role. Inventing a separate permission
 * would have added a row to the role matrix that every role holding the billing permission
 * would then need anyway, and a permission nobody holds separately is a permission that
 * drifts out of the matrix unnoticed.
 *
 * AUDIT IS NOT OPTIONAL HERE. These are exactly the "administrative overrides" an
 * investigation asks about: who granted this customer that, when, and why. The `reason` the
 * table demands is carried into the audit record.
 */

import type { AuditSink } from '@growth-os/audit';
import { userActor } from '@growth-os/audit';
import { type ActorContext, assertPermission } from '@growth-os/authz';
import { ValidationError } from '@growth-os/errors';
import { capability } from './catalogue.js';
import type { Clock, OverrideRepository } from './ports.js';

export interface EntitlementAdminDependencies {
  readonly overrides: OverrideRepository;
  readonly audit: AuditSink;
  readonly clock: Clock;
}

export interface GrantOverrideInput {
  readonly actor: ActorContext;
  /** Null for the whole organization; a workspace id to narrow it to one client. */
  readonly workspaceId?: string | undefined;
  readonly capabilityKey: string;
  readonly enabled: boolean;
  readonly limitValue?: number | undefined;
  readonly isUnlimited?: boolean | undefined;
  /** Why. Required by the table and carried into the audit record. */
  readonly reason: string;
  readonly expiresAt?: Date | undefined;
}

function assertKnown(capabilityKey: string): void {
  if (capability(capabilityKey) === undefined) {
    // A typo'd key would be stored happily and then silently never consulted, which reads
    // as "the override did not work" months later.
    throw new ValidationError(`Unknown capability: ${capabilityKey}`);
  }
}

/**
 * Everything that must hold before an override is written.
 *
 * Separated from the write so the write reads as one statement. The workspace check is the
 * load-bearing one: without it a caller holding `billing.subscription:manage` could grant a
 * capability into a workspace it cannot otherwise see, which is the enumeration defect
 * migration 0007 closed on `workspaces` arriving through a different door.
 */
function assertGrantIsWellFormed(input: GrantOverrideInput): void {
  assertKnown(input.capabilityKey);

  if (
    input.workspaceId !== undefined &&
    !input.actor.accessibleWorkspaceIds.includes(input.workspaceId)
  ) {
    throw new ValidationError('That workspace is not available to you.');
  }
  if (input.isUnlimited === true && input.limitValue !== undefined) {
    throw new ValidationError('An override is either unlimited or bounded, not both.');
  }
  if (input.reason.trim().length === 0) {
    throw new ValidationError('An entitlement override must state a reason.');
  }
}

/** The audit metadata for a grant: the capability and the shape of it, never the terms. */
function grantMetadata(input: GrantOverrideInput): Record<string, unknown> {
  return {
    capability: input.capabilityKey,
    enabled: input.enabled,
    unlimited: input.isUnlimited ?? false,
    ...(input.limitValue === undefined ? {} : { limit: input.limitValue }),
    reason: input.reason,
    scope: input.workspaceId === undefined ? 'organization' : 'workspace',
    expires: input.expiresAt?.toISOString() ?? null,
  };
}

/**
 * Writes an override, replacing any existing one for the same scope and capability.
 *
 * The organization comes from the ACTOR, never from the request: an override cannot be
 * written into a tenant the caller is not acting in, and RLS refuses it even if the
 * application layer were bypassed.
 */
export async function grantOverride(
  deps: EntitlementAdminDependencies,
  input: GrantOverrideInput,
): Promise<string> {
  assertPermission(input.actor, 'billing.subscription:manage');
  assertGrantIsWellFormed(input);

  const id = await deps.overrides.upsert({
    organizationId: input.actor.organizationId,
    workspaceId: input.workspaceId ?? null,
    capabilityKey: input.capabilityKey,
    enabled: input.enabled,
    ...(input.limitValue === undefined ? {} : { limitValue: input.limitValue }),
    isUnlimited: input.isUnlimited ?? false,
    reason: input.reason,
    expiresAt: input.expiresAt ?? null,
    grantedBy: input.actor.userId ?? null,
  });

  await deps.audit.record({
    // Granting and revoking are distinct actions, not one action with a boolean, because a
    // query for "every capability withdrawn last quarter" should not have to read metadata.
    action: input.enabled ? 'entitlements.override.granted' : 'entitlements.override.revoked',
    result: 'succeeded',
    actor: userActor(input.actor.userId ?? null),
    organizationId: input.actor.organizationId,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    resourceType: 'entitlement_override',
    resourceId: input.capabilityKey,
    // The capability, the shape of the grant and the stated reason. No commercial terms, no
    // payment details, no provider identifiers.
    metadata: grantMetadata(input),
  });

  return id;
}

/** Removes an override, returning the decision to the plan or the catalogue default. */
export async function removeOverride(
  deps: EntitlementAdminDependencies,
  actor: ActorContext,
  capabilityKey: string,
  workspaceId?: string,
): Promise<boolean> {
  assertPermission(actor, 'billing.subscription:manage');
  assertKnown(capabilityKey);

  const removed = await deps.overrides.remove(
    actor.organizationId,
    workspaceId ?? null,
    capabilityKey,
  );

  if (removed) {
    await deps.audit.record({
      action: 'entitlements.override.removed',
      result: 'succeeded',
      actor: userActor(actor.userId ?? null),
      organizationId: actor.organizationId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      resourceType: 'entitlement_override',
      resourceId: capabilityKey,
      metadata: {
        capability: capabilityKey,
        scope: workspaceId === undefined ? 'organization' : 'workspace',
      },
    });
  }
  return removed;
}
