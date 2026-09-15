/**
 * The guarantee under test (18-phase-0-plan.md exit criterion 12): a secret-valued field
 * cannot appear in log output through ANY code path.
 *
 * Each case represents a real way a credential reaches a log call — a named field, a nested
 * provider response, an error message, a bare string, an array, an unanticipated shape.
 */
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, redact, redactString, withCorrelationContext } from './index.js';

/**
 * Captures what the production logger writes. The logger is built by createLogger with the
 * real redaction configuration; only the destination differs.
 */
function capture(fn: (log: ReturnType<typeof createLogger>) => void): string {
  let output = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      output += chunk.toString();
      cb();
    },
  });

  const log = createLogger({
    service: 'test',
    environment: 'test',
    level: 'trace',
    destination: stream,
  });
  fn(log);
  return output;
}

const SECRET = 'sk-live-abcdef0123456789abcdef0123456789';
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('redaction removes secrets before serialisation', () => {
  it.each([
    ['top-level named field', { password: 'hunter2' }],
    ['snake_case variant', { refresh_token: SECRET }],
    ['camelCase variant', { refreshToken: SECRET }],
    ['nested one level', { user: { apiKey: SECRET } }],
    ['nested three levels', { a: { b: { c: { clientSecret: SECRET } } } }],
    ['inside an array', { items: [{ token: SECRET }] }],
    ['http headers', { headers: { authorization: `Bearer ${SECRET}` } }],
    ['cookie header', { headers: { cookie: `session=${SECRET}` } }],
    ['mfa secret', { totpSecret: SECRET }],
  ])('%s', (_name, payload) => {
    const out = capture((log) => log.info(payload, 'request completed'));
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('[redacted]');
  });

  it('redacts credential-shaped values even under an innocuous key', () => {
    // The key gives no clue, so only value-shape detection can catch this.
    const out = capture((log) => log.info({ note: `token is ${JWT}` }, 'note'));
    expect(out).not.toContain(JWT);
  });

  it('redacts a secret embedded in the log message itself', () => {
    const out = capture((log) => log.info(`authorization: Bearer ${SECRET}`));
    expect(out).not.toContain(SECRET);
  });

  it('redacts a secret inside an Error message and stack', () => {
    const out = capture((log) =>
      log.error({ err: new Error(`failed with key ${SECRET}`) }, 'boom'),
    );
    expect(out).not.toContain(SECRET);
  });

  it('redacts our own API key format', () => {
    const key = 'gos_live_ab12_ZYXWVUTSRQPONMLKJIHGFEDCBA987654';
    const out = capture((log) => log.info({ detail: key }, 'key seen'));
    expect(out).not.toContain(key);
  });

  it('redacts a PEM private key', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----';
    const out = capture((log) => log.info({ blob: pem }, 'pem'));
    expect(out).not.toContain('MIIEvQIBADANBg');
  });

  it('still logs the non-sensitive fields around a redacted one', () => {
    const out = capture((log) => log.info({ userId: 'u-1', password: 'hunter2' }, 'signin'));
    expect(out).toContain('u-1');
    expect(out).not.toContain('hunter2');
  });
});

describe('redact() is safe on hostile input', () => {
  it('handles circular structures', () => {
    // A declared shape rather than a Record: no index signature, so the self-reference
    // needs neither bracket access nor a lint suppression.
    const a: { token: string; self?: unknown } = { token: SECRET };
    a.self = a;
    const result = JSON.stringify(redact(a));
    expect(result).not.toContain(SECRET);
    expect(result).toContain('[circular]');
  });

  it('bounds depth rather than recursing without limit', () => {
    let deep: Record<string, unknown> = { token: SECRET };
    for (let i = 0; i < 50; i++) deep = { nested: deep };
    expect(() => redact(deep)).not.toThrow();
    expect(JSON.stringify(redact(deep))).not.toContain(SECRET);
  });

  it('leaves ordinary values untouched', () => {
    expect(redactString('a normal message')).toBe('a normal message');
    expect(redact({ count: 3, ok: true, name: 'campaign' })).toEqual({
      count: 3,
      ok: true,
      name: 'campaign',
    });
  });
});

describe('correlation context', () => {
  it('attaches ids to every line without the call site passing them', () => {
    const out = withCorrelationContext(
      { requestId: 'req-1', organizationId: 'org-1', workspaceId: 'ws-1' },
      () => capture((log) => log.info('inside request')),
    );
    expect(out).toContain('req-1');
    expect(out).toContain('org-1');
    expect(out).toContain('ws-1');
  });

  it('merges nested contexts', () => {
    const out = withCorrelationContext({ requestId: 'req-1' }, () =>
      withCorrelationContext({ jobId: 'job-9' }, () => capture((log) => log.info('nested'))),
    );
    expect(out).toContain('req-1');
    expect(out).toContain('job-9');
  });
});

/**
 * OAuth credentials must not survive into a log line.
 *
 * The PKCE verifier is the one that matters: an attacker holding an intercepted authorization
 * code still cannot exchange it without the verifier, so a verifier in a log undoes PKCE
 * entirely.
 */
describe('OAuth credentials are redacted', () => {
  it.each([
    'codeVerifier',
    'code_verifier',
    'pkceVerifier',
    'pkce_verifier',
    'authorizationCode',
    'authorization_code',
    'id_token',
    'access_token',
    'refresh_token',
    'client_secret',
  ])('redacts %s', (key) => {
    const output = capture((log) => log.info({ [key]: 'super-secret-value' }, 'oauth'));
    expect(output).not.toContain('super-secret-value');
  });

  /**
   * Deliberately NOT redacted. These key names collide with innocuous fields everywhere — an
   * error code, an HTTP status code, a UI state — and blanket-redacting them would gut the
   * logs and teach people that [redacted] carries no signal. The OAuth module never logs
   * them; that is enforced where they live, not here.
   */
  it.each(['code', 'state', 'nonce'])('leaves %s alone, by design', (key) => {
    const output = capture((log) => log.info({ [key]: 'ordinary-value' }, 'not a credential'));
    expect(output).toContain('ordinary-value');
  });
});
