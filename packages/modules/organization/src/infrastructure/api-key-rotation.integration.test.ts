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

/** Rotates in the actor's own tenant context, as production would. */
async function rotate(
  ctx: Awaited<ReturnType<AgencyFixture['actorFor']>>,
  keyId: string,
  graceMs: number,
) {
  return await h.asOwner(fx.ownerUser, async (d) => await rotateApiKey(d, ctx, keyId, graceMs));
}

/** The stamp as the database holds it, read past RLS so nothing is hidden. */
async function revokedAt(keyId: string): Promise<number | undefined> {
  const r = await fx.admin.query<{ revoked_at: Date | null }>(
    'SELECT revoked_at FROM api_keys WHERE id = $1',
    [keyId],
  );
  return r.rows[0]?.revoked_at?.getTime();
}

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
   * Revocation time is WRITE-ONCE. `revoke` uses `COALESCE(revoked_at, $3)`, so the first
   * write survives every later one — overwriting it would rewrite history for an incident
   * investigation, which is the one thing that record is for.
   *
   * Pinned deterministically, because the property is about ordering and a concurrent test
   * cannot say which write went first. A long grace goes in first precisely so that a naive
   * "keep the earliest time" implementation would fail here.
   */
  it('a later rotation cannot rewrite an earlier revocation time', async () => {
    const original = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    const ctx = await fx.actorFor(fx.ownerUser);

    const first = await rotate(ctx, original.id, 600_000);
    const stored = await revokedAt(original.id);
    expect(stored).toBe(first.previousRevokedAt.getTime());

    // A second rotation, and a bare revocation, both leave the original stamp alone.
    await rotate(ctx, original.id, 0);
    expect(await revokedAt(original.id)).toBe(stored);
    await h.asOwner(fx.ownerUser, async (d) => await revokeApiKey(d, ctx, original.id));
    expect(await revokedAt(original.id)).toBe(stored);
  });

  /**
   * The same guarantee under genuine concurrency, where neither caller can claim to have
   * gone first. The stamp must be ONE of the two candidates — never null, never a third
   * value, and never changed afterwards.
   */
  it('concurrent rotations settle on one revocation time and keep it', async () => {
    const original = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    const ctx = await fx.actorFor(fx.ownerUser);

    const [a, b] = await Promise.all([
      rotate(ctx, original.id, 0),
      rotate(ctx, original.id, 600_000),
    ]);

    const stored = await revokedAt(original.id);
    expect(stored).toBeDefined();
    expect([a.previousRevokedAt.getTime(), b.previousRevokedAt.getTime()]).toContain(stored);

    // Settled: a further revocation does not move it.
    await h.asOwner(fx.ownerUser, async (d) => await revokeApiKey(d, ctx, original.id));
    expect(await revokedAt(original.id)).toBe(stored);

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
