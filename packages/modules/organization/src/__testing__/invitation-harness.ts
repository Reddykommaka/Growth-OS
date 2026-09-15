/**
 * The invitation wiring the redemption suites share.
 *
 * Creation and acceptance are exercised from several angles — who may invite, what a bad
 * token does, what a concurrent redemption does — and each angle is its own file. The wiring
 * is identical across them and is genuinely load-bearing: `accept` takes no organization,
 * because the production surface has none to take. Writing that helper once is what keeps a
 * later file from quietly passing one in and proving less than it appears to.
 */

import { withTenant } from '@growth-os/db';
import type { InvitationDelivery } from '../application/index.js';
import {
  type AcceptDependencies,
  acceptInvitation,
  createInvitation,
  type InvitationDependencies,
} from '../application/index.js';
import {
  createInvitationRepository,
  createMembershipWriter,
  createOrganizationReader,
  createRoleReader,
} from '../infrastructure/invitation-repository.js';
import { createTenantScopeFactory } from '../infrastructure/tenant-scope.js';
import type { AgencyFixture, Recorder } from './agency-fixture.js';

export interface InvitationHarness {
  readonly deps: InvitationDependencies;
  /** Everything the notifier was handed, in order. The token appears here and nowhere else. */
  readonly delivered: InvitationDelivery[];
  /** Makes the next delivery throw, to prove a failed send leaves no invitation behind. */
  failNextDelivery(error: Error): void;
  readonly acceptDeps: AcceptDependencies;
  /** Creation runs inside the inviter's own tenant context, as production would. */
  invite(
    userId: string,
    input: Omit<Parameters<typeof createInvitation>[1], 'actor'>,
  ): Promise<Awaited<ReturnType<typeof createInvitation>>>;
  /**
   * Acceptance takes only the token and the accepter's session.
   *
   * No organization, deliberately. The tenant comes from the token and the RLS policy
   * decides whether the row is really there (ADR-0018).
   */
  accept(
    token: string,
    userId: string,
    userEmail: string,
  ): Promise<Awaited<ReturnType<typeof acceptInvitation>>>;
}

export function createInvitationHarness(fx: AgencyFixture, recorder: Recorder): InvitationHarness {
  const delivered: InvitationDelivery[] = [];
  let failWith: Error | undefined;

  const deps: InvitationDependencies = {
    invitations: createInvitationRepository(fx.db.pool),
    roles: createRoleReader(fx.db.pool),
    memberships: createMembershipWriter(fx.db.pool),
    organizations: createOrganizationReader(fx.db.pool),
    audit: recorder.audit,
    clock: recorder.clock,
    notifier: {
      deliver: async (d) => {
        if (failWith !== undefined) {
          const error = failWith;
          failWith = undefined;
          throw error;
        }
        delivered.push(d);
      },
    },
  };

  const acceptDeps: AcceptDependencies = {
    scope: createTenantScopeFactory(fx.db.pool),
    audit: recorder.audit,
    clock: recorder.clock,
  };

  return {
    deps,
    acceptDeps,
    delivered,
    failNextDelivery(error) {
      failWith = error;
    },
    async invite(userId, input) {
      const ctx = await fx.actorFor(userId);
      return await withTenant(
        fx.db.pool,
        {
          organizationId: fx.agencyOrg,
          userId,
          workspaceIds: ctx.accessibleWorkspaceIds,
          workspaceScope: ctx.workspaceScope,
        },
        async (tx) =>
          await createInvitation(
            {
              ...deps,
              invitations: createInvitationRepository(tx.client),
              roles: createRoleReader(tx.client),
              organizations: createOrganizationReader(tx.client),
            },
            { ...input, actor: ctx },
          ),
      );
    },
    async accept(token, userId, userEmail) {
      return await acceptInvitation(acceptDeps, { token, userId, userEmail });
    },
  };
}
