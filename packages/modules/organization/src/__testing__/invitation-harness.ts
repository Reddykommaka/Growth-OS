/**
 * The invitation wiring the redemption suites share.
 *
 * Creation and acceptance are exercised from several angles — who may invite, what a bad
 * token does, what a concurrent redemption does — and each angle is its own file. The wiring
 * is identical across them and is genuinely load-bearing: `accept` takes no organization,
 * because the production surface has none to take. Writing that helper once is what keeps a
 * later file from quietly passing one in and proving less than it appears to.
 */

import type { ActorContext } from '@growth-os/authz';
import { withTenant } from '@growth-os/db';
import type { PoolClient } from 'pg';
import type { InvitationDelivery } from '../application/index.js';
import {
  type AcceptDependencies,
  acceptInvitation,
  createInvitation,
  type InvitationDependencies,
  resendInvitation,
  revokeInvitation,
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
  /** Resend, in the actor's own tenant context, exactly as production would run it. */
  resend(
    userId: string,
    invitationId: string,
  ): Promise<Awaited<ReturnType<typeof resendInvitation>>>;
  /** Revoke, likewise. */
  revoke(userId: string, invitationId: string): Promise<boolean>;
  /**
   * Two resends that GENUINELY overlap: both read the row before either writes.
   *
   * `Promise.all` over two independent transactions does not reliably produce that
   * interleaving — the first often commits before the second reads, which is two sequential
   * resends, and two sequential resends are both supposed to succeed. The race only exists
   * when both callers decided the invitation was pending from the SAME state, so the barrier
   * holds each one at that point until the other has reached it.
   *
   * Everything else is real: two pool connections, two transactions, the production service,
   * and the conditional UPDATE settling it in PostgreSQL.
   */
  raceResends(
    userId: string,
    invitationId: string,
  ): Promise<Awaited<ReturnType<typeof resendInvitation>>[]>;
  /** Runs `createInvitation` in the actor's context with dependencies overridden. */
  inviteUsing(
    userId: string,
    input: Omit<Parameters<typeof createInvitation>[1], 'actor'>,
    overrides: Partial<InvitationDependencies>,
  ): Promise<Awaited<ReturnType<typeof createInvitation>>>;
}

type InContext = <T>(
  userId: string,
  body: (client: PoolClient, ctx: ActorContext) => Promise<T>,
) => Promise<T>;

/** Releases only once `count` participants have arrived. */
function barrier(count: number) {
  let arrived = 0;
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= count) release();
    await open;
  };
}

/**
 * The two-transaction resend race, held apart from the factory so each stays readable.
 *
 * `findById` is wrapped only to place the barrier at the moment both callers have decided
 * the invitation is pending. Everything that decides the outcome — the transactions, the
 * conditional UPDATE, the row lock — is the production path against real PostgreSQL.
 */
async function raceTwoResends(
  inContext: InContext,
  bind: (client: PoolClient) => InvitationDependencies,
  userId: string,
  invitationId: string,
): Promise<Awaited<ReturnType<typeof resendInvitation>>[]> {
  const bothHaveRead = barrier(2);
  const one = async () =>
    await inContext(userId, async (client, ctx) => {
      const bound = bind(client);
      const repo = bound.invitations;
      return await resendInvitation(
        {
          ...bound,
          invitations: {
            ...repo,
            findById: async (...args) => {
              const found = await repo.findById(...args);
              await bothHaveRead();
              return found;
            },
          },
        },
        ctx,
        invitationId,
      );
    });
  return await Promise.all([one(), one()]);
}

export function createInvitationHarness(fx: AgencyFixture, recorder: Recorder): InvitationHarness {
  /** Repositories bound to one transaction — the shape every actor-driven call needs. */
  const bind = (client: PoolClient): InvitationDependencies => ({
    ...deps,
    invitations: createInvitationRepository(client),
    roles: createRoleReader(client),
    organizations: createOrganizationReader(client),
  });

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

  /** Runs a body in the actor's own tenant context, as production would. */
  const inContext: InContext = async (userId, body) => {
    const ctx = await fx.actorFor(userId);
    return await withTenant(
      fx.db.pool,
      {
        organizationId: fx.agencyOrg,
        userId,
        workspaceIds: ctx.accessibleWorkspaceIds,
        workspaceScope: ctx.workspaceScope,
      },
      async (tx) => await body(tx.client, ctx),
    );
  };

  return {
    deps,
    acceptDeps,
    delivered,
    failNextDelivery(error) {
      failWith = error;
    },
    async invite(userId, input) {
      return await inContext(
        userId,
        async (client, ctx) => await createInvitation(bind(client), { ...input, actor: ctx }),
      );
    },
    async accept(token, userId, userEmail) {
      return await acceptInvitation(acceptDeps, { token, userId, userEmail });
    },
    async resend(userId, invitationId) {
      return await inContext(
        userId,
        async (client, ctx) => await resendInvitation(bind(client), ctx, invitationId),
      );
    },
    async revoke(userId, invitationId) {
      return await inContext(
        userId,
        async (client, ctx) => await revokeInvitation(bind(client), ctx, invitationId),
      );
    },
    async inviteUsing(userId, input, overrides) {
      return await inContext(
        userId,
        async (client, ctx) =>
          await createInvitation({ ...bind(client), ...overrides }, { ...input, actor: ctx }),
      );
    },
    async raceResends(userId, invitationId) {
      return await raceTwoResends(inContext, bind, userId, invitationId);
    },
  };
}
