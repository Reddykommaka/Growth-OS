/**
 * Redaction.
 *
 * The asymmetry that shapes every rule here: a redacted field that did not need redacting
 * costs a little forensic detail, while a credential written into an append-only,
 * seven-year-retained table cannot be removed — the table has no UPDATE or DELETE grant.
 */
import { describe, expect, it } from 'vitest';
import { REDACTED, redactMetadata } from './redact.js';

describe('credentials never survive', () => {
  const secrets = {
    password: 'correct horse battery staple',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$abc',
    token: 'gos_live_abc_def',
    accessToken: 'ya29.a0Af',
    refresh_token: '1//0gabc',
    apiKey: 'gos_live_x_y',
    clientSecret: 'shhh',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    recoveryCode: 'abcd-efgh',
    sessionToken: 'sess_123',
    Authorization: 'Bearer abc',
    cookie: 'sid=1',
    pkceVerifier: 'v-1',
    nonce: 'n-1',
    salt: 's-1',
    privateKey: '-----BEGIN',
    signature: 'MEUCIQDx-forged-signature-bytes',
  };

  for (const [key, value] of Object.entries(secrets)) {
    it(`redacts ${key}`, () => {
      const out = redactMetadata({ [key]: value });
      expect(out[key]).toBe(REDACTED);
      // Checked against the VALUES only: a key name may legitimately appear in the output,
      // and an earlier version of this test failed because 'sig' is a substring of
      // 'signature'. The property under test is that the secret is gone, not the label.
      expect(Object.values(out)).not.toContain(value);
    });
  }

  it('redacts however the key is spelled', () => {
    for (const key of ['access_token', 'ACCESS_TOKEN', 'AccessToken', 'providerAccessToken']) {
      expect(redactMetadata({ [key]: 'v' })[key], key).toBe(REDACTED);
    }
  });

  it('redacts nested and array-nested secrets', () => {
    const out = redactMetadata({
      provider: { name: 'google', accessToken: 'secret-value' },
      attempts: [{ password: 'p1' }, { password: 'p2' }],
    });
    expect(JSON.stringify(out)).not.toContain('secret-value');
    expect(JSON.stringify(out)).not.toContain('p1');
  });

  /** Raw bytes are a hash, a key or a token. Nothing else arrives as a Buffer. */
  it('redacts binary values whatever the key is called', () => {
    expect(redactMetadata({ blob: Buffer.from('deadbeef', 'hex') })['blob']).toBe(REDACTED);
    expect(redactMetadata({ blob: new Uint8Array([1, 2, 3]) })['blob']).toBe(REDACTED);
  });
});

describe('the identifiers an investigation needs survive', () => {
  it('keeps the API key prefix — the public half, and how a leaked key is revoked', () => {
    expect(redactMetadata({ prefix: 'abc123' })['prefix']).toBe('abc123');
  });

  it('keeps ids, counts, roles and reasons', () => {
    const out = redactMetadata({
      sessionId: 's-1',
      apiKeyId: 'k-1',
      role: 'admin',
      reason: 'privilege_escalation',
      missingCount: 3,
      scopeCount: 2,
      mfaMethod: 'totp',
    });
    expect(out).toEqual({
      sessionId: 's-1',
      apiKeyId: 'k-1',
      role: 'admin',
      reason: 'privilege_escalation',
      missingCount: 3,
      scopeCount: 2,
      mfaMethod: 'totp',
    });
  });

  it('keeps dates in a stable form', () => {
    expect(redactMetadata({ at: new Date('2026-09-17T10:00:00.000Z') })['at']).toBe(
      '2026-09-17T10:00:00.000Z',
    );
  });
});

describe('hostile input cannot break the audit write', () => {
  /** An audit write that throws is a lost security record, so nothing here may throw. */
  it('survives a cycle', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => redactMetadata(cyclic)).not.toThrow();
  });

  it('survives very deep nesting, replacing beyond the bound', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 100; i++) deep = { next: deep };
    const out = redactMetadata(deep);
    expect(JSON.stringify(out)).toContain(REDACTED);
  });

  it('summarises a huge array rather than storing all of it', () => {
    const out = redactMetadata({ items: Array.from({ length: 500 }, (_, i) => i) });
    const items = out['items'] as unknown[];
    expect(items.length).toBeLessThanOrEqual(51);
    expect(String(items.at(-1))).toMatch(/more/);
  });

  it('turns undefined and non-objects into something recordable', () => {
    expect(redactMetadata(undefined)).toEqual({});
    expect(() => redactMetadata({ fn: () => 1 })).not.toThrow();
    expect(redactMetadata({ fn: () => 1 })['fn']).toBe(REDACTED);
  });
});
