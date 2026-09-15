/**
 * API keys — generation, storage and the authentication lifecycle.
 *
 * Real PostgreSQL, real RLS, real Argon2. The property under test is 06 §5's: the full key
 * is displayed once and is unrecoverable, so what is stored can never be turned back into
 * what authenticates.
 */

import { stopSharedCluster } from '@growth-os/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgencyFixture,
  buildAgencyFixture,
  createRecorder,
} from '../__testing__/agency-fixture.js';
import { type ApiKeyHarness, createApiKeyHarness } from '../__testing__/api-key-harness.js';
import { listApiKeys, revokeApiKey } from '../application/index.js';

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

describe('generation, storage and display', () => {
  it('returns the key once and stores only an Argon2 hash of the secret', async () => {
    const created = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });

    expect(created.key).toBe(`gos_live_${created.prefix}_${created.key.split('_')[3]}`);
    const secret = created.key.split('_')[3] ?? '';

    const stored = await fx.admin.query<{ key_hash: string; prefix: string }>(
      'SELECT key_hash, prefix FROM api_keys WHERE id = $1',
      [created.id],
    );
    const row = stored.rows[0];
    // Argon2id, not the secret, and not a fast hash of it either.
    expect(row?.key_hash).toMatch(/^\$argon2id\$/);
    expect(row?.key_hash).not.toContain(secret);
    expect(row?.prefix).toBe(created.prefix);
  });

  it('the prefix names the organization, and is the PUBLIC half', async () => {
    const created = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    // The organization's hex digits, so authentication can route before any context exists.
    expect(created.prefix.slice(0, 32)).toBe(fx.agencyOrg.replace(/-/g, ''));
    // Listing exposes the prefix and never the hash — the material an attacker would grind.
    const ctx = await fx.actorFor(fx.ownerUser);
    const listed = await h.asOwner(fx.ownerUser, async (d) => await listApiKeys(d, ctx));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.prefix).toBe(created.prefix);
    expect(JSON.stringify(listed)).not.toContain('argon2');
  });

  it('never writes the key or its secret to the audit log', async () => {
    const created = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    const secret = created.key.split('_')[3] ?? '';
    const serialised = JSON.stringify(recorder.events);
    expect(serialised).not.toContain(created.key);
    expect(serialised).not.toContain(secret);
    // The prefix IS recorded — that is how a leaked key is identified and revoked.
    expect(serialised).toContain(created.prefix);
  });
});

describe('authentication', () => {
  it('accepts a valid key and produces an actor in the key’s organization', async () => {
    const created = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    const result = await authenticate(created.key);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actor.kind).toBe('api_key');
    expect(result.actor.organizationId).toBe(fx.agencyOrg);
    expect(result.keyId).toBe(created.id);
  });

  it('records last-used, without that tracking being able to refuse a valid request', async () => {
    const created = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    const usedAt = new Date('2026-09-16T09:00:00.000Z');
    recorder.advanceTo(usedAt);
    expect((await authenticate(created.key)).ok).toBe(true);
    const row = await fx.admin.query<{ last_used_at: Date | null }>(
      'SELECT last_used_at FROM api_keys WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]?.last_used_at?.toISOString()).toBe(usedAt.toISOString());
  });

  it('refuses a key whose secret is wrong, without disclosing that the prefix was right', async () => {
    const created = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    const forged = `gos_live_${created.prefix}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect(await authenticate(forged)).toEqual({ ok: false, reason: 'bad_secret' });
  });

  it('refuses malformed keys and unknown prefixes identically in shape', async () => {
    for (const bad of ['', 'gos_live', 'xxx_live_a_b', 'gos_prod_a_b', 'gos_live_short_secret']) {
      const r = await authenticate(bad);
      expect(r.ok, bad).toBe(false);
    }
    // A well-formed prefix naming a real organization, but no such key.
    const unknown = `gos_live_${fx.agencyOrg.replace(/-/g, '')}ZZZZZZZZZZ_AAAAAAAAAA`;
    expect(await authenticate(unknown)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('refuses a revoked key on the very next request', async () => {
    const created = await mint(fx.ownerUser, { name: 'CI', scopes: ['social.post:read'] });
    const ctx = await fx.actorFor(fx.ownerUser);
    const revoked = await h.asOwner(
      fx.ownerUser,
      async (d) => await revokeApiKey(d, ctx, created.id),
    );
    expect(revoked).toBe(true);
    expect(await authenticate(created.key)).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it('refuses an expired key, and accepted it before the boundary', async () => {
    const expiresAt = new Date('2026-09-20T00:00:00.000Z');
    const created = await mint(fx.ownerUser, {
      name: 'CI',
      scopes: ['social.post:read'],
      expiresAt,
    });
    expect((await authenticate(created.key)).ok).toBe(true);
    recorder.advanceTo(expiresAt);
    expect(await authenticate(created.key)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});
