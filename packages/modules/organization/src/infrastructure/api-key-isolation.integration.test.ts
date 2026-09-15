/**
 * API keys — the boundaries a key must not cross.
 *
 * The property this file exists to defend is that an API key is a machine actor INSIDE a
 * tenant, never a way around one. So the assertions are not "a valid key authenticates" but
 * "a valid key is refused everything it was not granted" — across the organization boundary,
 * the workspace boundary and its own scope list, with the database asked independently.
 */

import { randomUUID } from 'node:crypto';
import { decide } from '@growth-os/authz';
import { withTenant } from '@growth-os/db';
import { ForbiddenError, ValidationError } from '@growth-os/errors';
import { stopSharedCluster } from '@growth-os/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgencyFixture,
  buildAgencyFixture,
  createRecorder,
} from '../__testing__/agency-fixture.js';
import { type ApiKeyHarness, createApiKeyHarness } from '../__testing__/api-key-harness.js';

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

describe('a key is never a tenant-isolation bypass', () => {
  /**
   * THE CROSS-TENANT ATTACK, in the form the new key format makes expressible: take a valid
   * key and rewrite the organization half of its prefix to point at another tenant.
   *
   * It must find nothing. Two mechanisms refuse it independently — the RLS policy (the row
   * is invisible in the scope the forged prefix opens) and the unique prefix index (there is
   * no such prefix anywhere).
   */
  it('a key prefix rewritten to name another organization authenticates nothing', async () => {
    const created = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    const secret = created.key.split('_')[3] ?? '';
    const forgedPrefix = fx.rivalOrg.replace(/-/g, '') + created.prefix.slice(32);
    const forged = `gos_live_${forgedPrefix}_${secret}`;

    expect(await authenticate(forged)).toEqual({ ok: false, reason: 'unknown' });
    // The genuine key still works, so the refusal was about the forgery.
    expect((await authenticate(created.key)).ok).toBe(true);
  });

  it('an authenticated key cannot reach another organization’s workspace', async () => {
    const created = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    const result = await authenticate(created.key);
    if (!result.ok) throw new Error('setup');

    expect(result.actor.accessibleWorkspaceIds).not.toContain(fx.rivalWorkspace);
    expect(
      decide(result.actor, 'social.post:read', {
        type: 'post',
        id: randomUUID(),
        workspaceId: fx.rivalWorkspace,
      }).allowed,
    ).toBe(false);
  });

  /**
   * The RLS backstop, driven through the key's own resolved context. Even if every check
   * above were removed, the database would return nothing.
   */
  it('the database refuses a cross-tenant read under the key’s own context', async () => {
    const created = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    const result = await authenticate(created.key);
    if (!result.ok) throw new Error('setup');

    const rows = await withTenant(
      fx.db.pool,
      {
        organizationId: result.actor.organizationId,
        workspaceIds: result.actor.accessibleWorkspaceIds,
        workspaceScope: result.actor.workspaceScope,
      },
      async (tx) => {
        const r = await tx.query('SELECT id FROM workspaces WHERE id = $1', [fx.rivalWorkspace]);
        return r.rowCount;
      },
    );
    expect(rows).toBe(0);
  });
});

describe('scope and workspace restriction', () => {
  it('a narrowed key intersects rather than unions — it cannot widen itself', async () => {
    const created = await mint(fx.ownerUser, {
      name: 'Acme integration',
      scopes: ['social.post:read'],
      workspaceId: fx.acme,
    });
    const result = await authenticate(created.key);
    if (!result.ok) throw new Error('setup');

    // The owner who minted it can reach both workspaces. The key can reach exactly one.
    expect(result.actor.accessibleWorkspaceIds).toEqual([fx.acme]);
    expect(
      decide(result.actor, 'social.post:read', {
        type: 'post',
        id: randomUUID(),
        workspaceId: fx.acme,
      }).allowed,
    ).toBe(true);
    expect(
      decide(result.actor, 'social.post:read', {
        type: 'post',
        id: randomUUID(),
        workspaceId: fx.borealis,
      }).allowed,
    ).toBe(false);
  });

  it('a key is refused a permission outside its scope list, even in its own workspace', async () => {
    const created = await mint(fx.ownerUser, { name: 'Read only', scopes: ['social.post:read'] });
    const result = await authenticate(created.key);
    if (!result.ok) throw new Error('setup');

    expect(
      decide(result.actor, 'social.post:publish', {
        type: 'post',
        id: randomUUID(),
        workspaceId: fx.acme,
      }).allowed,
    ).toBe(false);
  });

  /**
   * THE ESCALATION. `api_key:create` is otherwise a promotion: mint a key carrying scopes
   * you do not hold, then act through it.
   *
   * The administrator is the right actor to prove it with — they genuinely hold
   * `api_key:create`, so the refusal comes from the scope check rather than from the
   * permission check in front of it. `organization:delete` is the one thing the role is
   * defined to lack.
   */
  it('refuses to mint a key carrying permissions its creator does not hold', async () => {
    await expect(
      mint(fx.adminUser, { name: 'Escalation', scopes: ['organization.organization:delete'] }),
    ).rejects.toThrow(ValidationError);
    expect((await fx.admin.query('SELECT 1 FROM api_keys')).rowCount).toBe(0);

    // And the owner, who does hold it, may — so the refusal was about the creator's
    // permissions and not about the permission being unmintable.
    const created = await mint(fx.ownerUser, {
      name: 'Legitimate',
      scopes: ['organization.organization:delete'],
    });
    expect((await authenticate(created.key)).ok).toBe(true);
  });

  it('refuses a creator who lacks the create permission entirely', async () => {
    // The editor is a workspace-scoped role; api_key management is deliberately outside it.
    await expect(
      mint(fx.editorUser, { name: 'Nope', scopes: ['social.post:read'] }),
    ).rejects.toThrow(ForbiddenError);
    expect((await fx.admin.query('SELECT 1 FROM api_keys')).rowCount).toBe(0);
  });

  /**
   * The cross-tenant form of the workspace check: an owner with full rights IN THEIR OWN
   * ORGANIZATION naming another tenant's workspace.
   */
  it('refuses to narrow a key to a workspace its creator cannot reach', async () => {
    await expect(
      mint(
        fx.rivalOwnerUser,
        { name: 'Reach', scopes: ['social.post:read'], workspaceId: fx.acme },
        fx.rivalOrg,
      ),
    ).rejects.toThrow(ValidationError);
    expect((await fx.admin.query('SELECT 1 FROM api_keys')).rowCount).toBe(0);
  });

  it('refuses a key with no scopes at all', async () => {
    await expect(mint(fx.ownerUser, { name: 'Empty', scopes: [] })).rejects.toThrow(
      ValidationError,
    );
  });
});
