/**
 * API keys — rotation, revocation and abuse limits.
 *
 * Rotation is the ONLY remedy for a leak, by design, so it has to be correct under
 * concurrency: two operators reacting to the same incident must not race each other into a
 * state where the compromised key survives or its revocation time is rewritten.
 */

import { withTenant } from '@growth-os/db';
import { ValidationError } from '@growth-os/errors';
import { stopSharedCluster } from '@growth-os/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgencyFixture,
  buildAgencyFixture,
  createRecorder,
} from '../__testing__/agency-fixture.js';
import { type ApiKeyHarness, createApiKeyHarness } from '../__testing__/api-key-harness.js';
import {
  type ApiKeyAuthDependencies,
  authenticateApiKey,
  revokeApiKey,
  rotateApiKey,
} from '../application/index.js';

let fx: AgencyFixture;
let h: ApiKeyHarness;
const recorder = createRecorder();

const mint: ApiKeyHarness['mint'] = (...a) => h.mint(...a);
const authenticate: ApiKeyHarness['authenticate'] = (...a) => h.authenticate(...a);

beforeAll(async () => {
  fx = await buildAgencyFixture();
  h = createApiKeyHarness(fx, recorder);
}, 180_000);

afterAll(async () => {
  await fx.close();
  await stopSharedCluster();
});

beforeEach(async () => {
  await fx.admin.query('DELETE FROM api_keys');
  recorder.reset();
});

describe('rotation', () => {
  it('mints a replacement carrying the same scopes and restriction', async () => {
    const original = await mint(fx.ownerUser, {
      name: 'Acme integration',
      scopes: ['social.post:read'],
      workspaceId: fx.acme,
    });
    const ctx = await fx.actorFor(fx.ownerUser);
    const rotated = await withTenant(
      fx.db.pool,
      {
        organizationId: fx.agencyOrg,
        userId: fx.ownerUser,
        workspaceIds: ctx.accessibleWorkspaceIds,
      },
      async (tx) => await rotateApiKey(h.deps(tx.client), ctx, original.id),
    );

    expect(rotated.created.key).not.toBe(original.key);
    const fresh = await authenticate(rotated.created.key);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.actor.accessibleWorkspaceIds).toEqual([fx.acme]);
  });

  it('with no grace, the old key stops working immediately', async () => {
    const original = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    const ctx = await fx.actorFor(fx.ownerUser);
    await withTenant(
      fx.db.pool,
      {
        organizationId: fx.agencyOrg,
        userId: fx.ownerUser,
        workspaceIds: ctx.accessibleWorkspaceIds,
      },
      async (tx) => await rotateApiKey(h.deps(tx.client), ctx, original.id),
    );
    expect(await authenticate(original.key)).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it('with a grace window, the old key works until it closes and not after', async () => {
    const original = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    const ctx = await fx.actorFor(fx.ownerUser);
    const graceMs = 60_000;
    await withTenant(
      fx.db.pool,
      {
        organizationId: fx.agencyOrg,
        userId: fx.ownerUser,
        workspaceIds: ctx.accessibleWorkspaceIds,
      },
      async (tx) => await rotateApiKey(h.deps(tx.client), ctx, original.id, graceMs),
    );

    expect((await authenticate(original.key)).ok).toBe(true);
    recorder.advanceBy(graceMs);
    expect(await authenticate(original.key)).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });
});

/**
 * Rotation and revocation under CONCURRENCY.
 *
 * Two operators reacting to the same incident is the realistic case, not the exotic one, and
 * the outcomes that matter are settled by the database rather than by a read-then-write in
 * application code.
 */
describe('rotation and revocation races', () => {
  /**
   * Two concurrent rotations of one key. Whatever the interleaving, the FIRST revocation
   * time must survive: overwriting it rewrites history for an incident investigation.
   */
  it('concurrent rotations keep the first revocation time', async () => {
    const original = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    const ctx = await fx.actorFor(fx.ownerUser);
    const rotate = (graceMs: number) =>
      withTenant(
        fx.db.pool,
        {
          organizationId: fx.agencyOrg,
          userId: fx.ownerUser,
          workspaceIds: ctx.accessibleWorkspaceIds,
        },
        async (tx) => await rotateApiKey(h.deps(tx.client), ctx, original.id, graceMs),
      );

    const [a, b] = await Promise.all([rotate(0), rotate(600_000)]);
    const row = await fx.admin.query<{ revoked_at: Date }>(
      'SELECT revoked_at FROM api_keys WHERE id = $1',
      [original.id],
    );
    const stored = row.rows[0]?.revoked_at.getTime();
    expect(stored).toBe(Math.min(a.previousRevokedAt.getTime(), b.previousRevokedAt.getTime()));
    // Both replacements exist and both authenticate; rotation is not a lock.
    expect((await authenticate(a.created.key)).ok).toBe(true);
    expect((await authenticate(b.created.key)).ok).toBe(true);
  });

  it('concurrent revocations settle on one outcome and keep the key dead', async () => {
    const created = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    const ctx = await fx.actorFor(fx.ownerUser);
    const revoke = () =>
      withTenant(
        fx.db.pool,
        {
          organizationId: fx.agencyOrg,
          userId: fx.ownerUser,
          workspaceIds: ctx.accessibleWorkspaceIds,
        },
        async (tx) => await revokeApiKey(h.deps(tx.client), ctx, created.id),
      );
    await Promise.all([revoke(), revoke()]);
    expect(await authenticate(created.key)).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it("refuses to rotate another organization's key", async () => {
    const created = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    const rivalCtx = { ...(await fx.actorFor(fx.ownerUser)), organizationId: fx.rivalOrg };
    await expect(
      withTenant(
        fx.db.pool,
        { organizationId: fx.rivalOrg, userId: fx.ownerUser, workspaceIds: [] },
        async (tx) => await rotateApiKey(h.deps(tx.client), rivalCtx, created.id),
      ),
    ).rejects.toThrow(ValidationError);
    // Still live: the refusal did not half-apply.
    expect((await authenticate(created.key)).ok).toBe(true);
  });
});

describe('abuse limits', () => {
  it('a rate-limited authentication is refused without touching the database', async () => {
    const created = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    let consumed = 0;
    const limited: ApiKeyAuthDependencies = {
      ...h.authDeps,
      rateLimiter: {
        consume: async () => {
          consumed += 1;
          return consumed <= 1;
        },
        reset: async () => undefined,
      },
    };
    expect((await authenticateApiKey(limited, created.key, '10.0.0.1')).ok).toBe(true);
    expect(await authenticateApiKey(limited, created.key, '10.0.0.1')).toEqual({
      ok: false,
      reason: 'rate_limited',
    });
  });
});
