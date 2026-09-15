/**
 * Token primitives.
 *
 * The property under test throughout: what the holder receives and what the database stores
 * are different values, and the stored one cannot be turned back into the usable one.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashRecoveryCode,
  hashToken,
  issueApiKey,
  issueRecoveryCode,
  issueTenantToken,
  issueToken,
  normaliseRecoveryCode,
  organizationIdFromApiKeyPrefix,
  parseApiKey,
  parseTenantToken,
  tokenHashEquals,
} from './tokens.js';

describe('session and verification tokens', () => {
  it('carries 256 bits of entropy', () => {
    const { token } = issueToken();
    // base64url of 32 bytes, unpadded.
    expect(token).toHaveLength(43);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('is URL- and cookie-safe, needing no escaping', () => {
    for (let i = 0; i < 200; i++) {
      const { token } = issueToken();
      expect(token, token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encodeURIComponent(token)).toBe(token);
    }
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => issueToken().token));
    expect(seen.size).toBe(1000);
  });

  /**
   * The property a database leak rests on: the stored value is a one-way hash of the token,
   * so a dump yields nothing that can be presented as a session.
   */
  it('stores only sha256(token), never the token', () => {
    const { token, tokenHash } = issueToken();
    expect(tokenHash.equals(createHash('sha256').update(token, 'utf8').digest())).toBe(true);
    expect(tokenHash.toString('base64url')).not.toBe(token);
    expect(tokenHash.toString('utf8')).not.toContain(token);
  });

  it('hashes deterministically, so a presented token finds its row', () => {
    const { token, tokenHash } = issueToken();
    expect(hashToken(token).equals(tokenHash)).toBe(true);
  });

  it('compares hashes safely, including mismatched lengths', () => {
    const a = hashToken('one');
    const b = hashToken('two');
    expect(tokenHashEquals(a, a)).toBe(true);
    expect(tokenHashEquals(a, b)).toBe(false);
    expect(tokenHashEquals(a, Buffer.alloc(8))).toBe(false);
  });
});

const ORG = '01998000-0000-7000-8000-00000000000a';
const OTHER_ORG = '01998000-0000-7000-8000-00000000000b';

describe('API keys', () => {
  it('uses the documented format, which secret scanners can match', () => {
    const { key, prefix, secret } = issueApiKey('live', ORG);
    expect(key).toBe(`gos_live_${prefix}_${secret}`);
    // The prefix is the organization's hex digits followed by a base32 random half; the
    // secret is base32 only. Neither alphabet may contain the `_` separator, or the key
    // cannot be parsed back — base64url did, and one key in three was unparseable.
    expect(key).toMatch(/^gos_live_[0-9a-f]{32}[A-Z2-7]+_[A-Z2-7]+$/);
  });

  /**
   * The prefix names the tenant, which is what lets authentication open a scope before any
   * context exists (ADR-0018). It is a routing hint and authorises nothing — but it must be
   * recoverable exactly, or a valid key would be routed to the wrong tenant and refused.
   */
  it('carries its organization in the prefix, recoverably', () => {
    const issued = issueApiKey('live', ORG);
    expect(organizationIdFromApiKeyPrefix(issued.prefix)).toBe(ORG);
    expect(organizationIdFromApiKeyPrefix(issueApiKey('live', OTHER_ORG).prefix)).toBe(OTHER_ORG);
  });

  it('refuses to issue a key for a malformed organization id', () => {
    for (const bad of ['', 'not-a-uuid', '01998000-0000-7000-8000-00000000000']) {
      expect(() => issueApiKey('live', bad), bad).toThrow(/well-formed organization id/);
    }
  });

  it('returns undefined for a prefix that names no organization', () => {
    for (const bad of ['', 'ABCDEFGH', 'z'.repeat(32), '0'.repeat(31), 'F'.repeat(32)]) {
      expect(organizationIdFromApiKeyPrefix(bad), bad).toBeUndefined();
    }
  });

  it('round-trips through the parser', () => {
    const issued = issueApiKey('live', ORG);
    const parsed = parseApiKey(issued.key);
    expect(parsed).toEqual({
      environment: 'live',
      prefix: issued.prefix,
      secret: issued.secret,
    });
  });

  it('supports a test environment distinct from live', () => {
    expect(parseApiKey(issueApiKey('test', ORG).key)?.environment).toBe('test');
  });

  /**
   * A malformed key returns undefined rather than throwing, so the caller treats "wrong
   * shape" and "wrong secret" identically. Distinguishing them turns the format into an
   * oracle that tells an attacker when they have the shape right.
   */
  it('returns undefined for anything malformed, never throws', () => {
    for (const bad of [
      '',
      'gos_live',
      'gos_live_abc',
      'gos_live_abc_def_ghi',
      'xxx_live_abc_def',
      'gos_prod_abc_def',
      'gos_live__def',
      'gos_live_abc_',
    ]) {
      expect(parseApiKey(bad), bad).toBeUndefined();
    }
  });

  it('gives each key an unpredictable prefix and secret', () => {
    const keys = Array.from({ length: 500 }, () => issueApiKey('live', ORG));
    expect(new Set(keys.map((k) => k.prefix)).size).toBe(500);
    expect(new Set(keys.map((k) => k.secret)).size).toBe(500);
  });

  /**
   * The regression for the separator collision. Every issued key must survive the round
   * trip — not most of them. A sample of one would have passed while a third of real keys
   * failed to authenticate.
   */
  it('EVERY issued key round-trips, across a large sample', () => {
    for (let i = 0; i < 2000; i++) {
      const issued = issueApiKey('live', ORG);
      const parsed = parseApiKey(issued.key);
      expect(parsed?.prefix, issued.key).toBe(issued.prefix);
      expect(parsed?.secret, issued.key).toBe(issued.secret);
      expect(organizationIdFromApiKeyPrefix(issued.prefix), issued.key).toBe(ORG);
    }
  });
});

/**
 * A tenant token names the organization it belongs to so that a credential presented before
 * any tenant context exists can say which tenant to open a scope for (ADR-0018). The hint
 * authorises nothing — but the HASH must cover it, so that a secret lifted from one
 * organization's token cannot be replayed against another by rewriting the segment.
 */
describe('tenant-scoped tokens', () => {
  it('is `<organizationId>.<secret>` with 256 bits in the secret half', () => {
    const { token } = issueTenantToken(ORG);
    const parsed = parseTenantToken(token);
    expect(parsed?.organizationId).toBe(ORG);
    expect(parsed?.secret).toHaveLength(43);
    expect(Buffer.from(parsed?.secret ?? '', 'base64url')).toHaveLength(32);
  });

  it('hashes the WHOLE token, so the same secret under another organization differs', () => {
    const { token, tokenHash } = issueTenantToken(ORG);
    const secret = token.slice(token.indexOf('.') + 1);
    expect(tokenHash).toEqual(hashToken(token));
    // The rewritten token — the cross-tenant replay — hashes to something else entirely.
    expect(hashToken(`${OTHER_ORG}.${secret}`).equals(tokenHash)).toBe(false);
    // And the bare secret is not the stored value either.
    expect(hashToken(secret).equals(tokenHash)).toBe(false);
  });

  it('refuses to issue for a malformed organization id', () => {
    for (const bad of ['', 'not-a-uuid', ORG.slice(0, -1)]) {
      expect(() => issueTenantToken(bad), bad).toThrow(/well-formed organization id/);
    }
  });

  it('returns undefined for anything malformed, never throws', () => {
    for (const bad of ['', '.', `${ORG}.`, `.secret`, 'no-dot-at-all', `not-a-uuid.secret`]) {
      expect(parseTenantToken(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('keeps a secret containing dots intact, so only the FIRST dot separates', () => {
    // base64url has no `.`, but a forgiving parser that split on every dot would truncate a
    // secret and silently refuse a valid token. Splitting at the first is what is asserted.
    expect(parseTenantToken(`${ORG}.aaa.bbb`)?.secret).toBe('aaa.bbb');
  });

  it('gives each token a distinct secret', () => {
    const tokens = Array.from({ length: 500 }, () => issueTenantToken(ORG).token);
    expect(new Set(tokens).size).toBe(500);
  });
});

describe('MFA recovery codes', () => {
  it('is grouped for transcription', () => {
    expect(issueRecoveryCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  /**
   * The ambiguous characters are excluded so a code read off paper cannot be mistyped into a
   * DIFFERENT valid code — the failure that makes someone burn a second code and eventually
   * lock themselves out.
   */
  it('excludes the characters that are misread on paper', () => {
    const codes = Array.from({ length: 500 }, () => issueRecoveryCode()).join('');
    for (const ambiguous of ['I', 'L', 'O', 'U']) {
      expect(codes, ambiguous).not.toContain(ambiguous);
    }
  });

  it('normalises case and separators, because people retype them loosely', () => {
    expect(normaliseRecoveryCode('abcd-1234')).toBe('ABCD1234');
    expect(normaliseRecoveryCode('ABCD 1234')).toBe('ABCD1234');
    expect(normaliseRecoveryCode('abcd1234')).toBe('ABCD1234');
  });

  it('hashes to the same value however it was typed', () => {
    const code = issueRecoveryCode();
    const hashed = hashRecoveryCode(code);
    expect(hashRecoveryCode(code.toLowerCase()).equals(hashed)).toBe(true);
    expect(hashRecoveryCode(code.replace('-', ' ')).equals(hashed)).toBe(true);
    expect(hashRecoveryCode(code.replace('-', '')).equals(hashed)).toBe(true);
  });

  it('stores a hash, not the code', () => {
    const code = issueRecoveryCode();
    expect(hashRecoveryCode(code).toString('base64url')).not.toContain(normaliseRecoveryCode(code));
  });

  it('does not repeat across a large sample', () => {
    const codes = Array.from({ length: 2000 }, () => issueRecoveryCode());
    // 32^8 ≈ 1.1e12 possibilities; 2000 draws should collide with vanishing probability.
    expect(new Set(codes).size).toBe(2000);
  });
});
