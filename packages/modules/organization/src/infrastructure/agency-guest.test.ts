/**
 * THE PHASE 1 EXIT CRITERION, part 2 (14-roadmap.md): the client guest.
 *
 * `client_guest` is the most security-sensitive role in the system because it is held by
 * someone OUTSIDE the tenant organization — the client's own reviewer, looking at their own
 * brand's work inside the agency's account (06-identity-and-access.md §3).
 *
 * The containment is stated here exactly as it actually holds. It once had a documented
 * gap — a guest could enumerate the agency's client list with raw SQL — which migration
 * 0007 closed; the test that pinned it now asserts the closure instead. See
 * workspace-boundary.test.ts for the full regression suite.
 */

import { randomUUID } from 'node:crypto';
import { decide } from '@growth-os/authz';
import { withTenant } from '@growth-os/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  clients,
  db,
  orgId,
  setupAgency,
  teardownAgency,
  users,
  visibleContent,
  visibleWorkspaces,
} from './__testing__/agency-fixture.js';
import { resolveActorContext } from './actor-resolver.js';

beforeAll(setupAgency, 180_000);
afterAll(teardownAgency);

async function guestContext() {
  const ctx = await resolveActorContext(db.pool, {
    userId: users.clientReviewer,
    organizationId: orgId,
    mfaSatisfied: true,
  });
  if (ctx === undefined) throw new Error('guest context did not resolve');
  return ctx;
}

describe('the client guest', () => {
  it('has exactly one workspace in its accessible set', async () => {
    expect((await guestContext()).accessibleWorkspaceIds).toEqual([clients['acme']]);
  });

  it('sees one workspace in the product listing', async () => {
    expect(await visibleWorkspaces(users.clientReviewer)).toEqual(['acme']);
  });

  it('may approve work in their own workspace', async () => {
    expect(
      decide(await guestContext(), 'social.post:approve', {
        type: 'post',
        id: 'p',
        workspaceId: clients['acme'] as string,
      }).allowed,
    ).toBe(true);
  });

  /**
   * The containment that matters most, and the one RLS enforces directly rather than
   * relying on an application check: a guest cannot read another client's WORK.
   */
  it("cannot read another client's content — enforced by RLS on the workspace-scoped table", async () => {
    expect(await visibleContent(users.clientReviewer)).toEqual(['acme-post']);
  });

  it('is denied every other workspace by the engine, before a query is issued', async () => {
    const ctx = await guestContext();
    for (const [name, workspaceId] of Object.entries(clients)) {
      if (name === 'acme') continue;
      const decision = decide(ctx, 'social.post:read', {
        type: 'post',
        id: 'p',
        workspaceId: workspaceId as string,
      });
      expect(decision.allowed, name).toBe(false);
      expect(decision.allowed === false && decision.reason).toBe('workspace_not_accessible');
    }
  });

  it("is denied the agency's costs, billing, members and integration credentials", async () => {
    const ctx = await guestContext();
    for (const p of [
      'analytics.cost:read',
      'billing.invoice:read',
      'organization.member:read',
      'integrations.credential:read',
      'organization.api_key:read',
    ] as const) {
      expect(decide(ctx, p).allowed, p).toBe(false);
    }
  });

  /**
   * CLOSED in migration 0007. This test previously asserted the opposite.
   *
   * `workspaces` used to carry only the organization predicate, so a guest with a bypassed
   * application check could enumerate the agency's whole client list. The test that pinned
   * that residual said, in its own comment, that closing the gap should make it fail and be
   * replaced with one asserting zero rows. This is that replacement.
   *
   * The guest's session carries workspace_scope 'set', so the policy itself now bounds the
   * read — no application filtering involved.
   */
  it('cannot enumerate other workspaces even with raw SQL — closed by migration 0007', async () => {
    const ctx = await guestContext();
    const rows = await withTenant(
      db.pool,
      {
        organizationId: orgId,
        userId: users.clientReviewer,
        workspaceIds: ctx.accessibleWorkspaceIds,
        workspaceScope: ctx.workspaceScope,
      },
      async (tx) => (await tx.query('SELECT slug FROM workspaces WHERE slug <> $1', ['acme'])).rows,
    );
    expect(rows).toEqual([]);
  });

  it("resolves to workspace scope 'set', never 'all'", async () => {
    expect((await guestContext()).workspaceScope).toBe('set');
  });
});

/**
 * The tenant boundary itself. RLS's job, and unaffected by the accessible set.
 */
describe('cross-organization isolation is enforced by RLS, not by the set', () => {
  it("another organization's workspace is invisible even with its id in the set", async () => {
    const otherOrg = randomUUID();
    const otherWorkspace = randomUUID();
    await admin.query(
      `INSERT INTO organizations (id, slug, name, kind) VALUES ($1, 'rival', 'Rival', 'agency')`,
      [otherOrg],
    );
    await admin.query(
      `INSERT INTO workspaces (id, organization_id, slug, name)
         VALUES ($1, $2, 'secret', 'Secret')`,
      [otherWorkspace, otherOrg],
    );

    const rows = await withTenant(
      db.pool,
      {
        organizationId: orgId,
        userId: users.principal,
        // Smuggling the rival's workspace id into the set AND claiming the widest scope.
        // RLS must still refuse: the organization predicate is the one that decides, and no
        // scope value relaxes it.
        workspaceIds: [otherWorkspace],
        workspaceScope: 'all',
      },
      async (tx) =>
        (await tx.query('SELECT slug FROM workspaces WHERE id = $1', [otherWorkspace])).rows,
    );
    expect(rows).toEqual([]);
  });
});
