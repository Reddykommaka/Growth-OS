import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigurationError, findServerEnvLeaks, loadClientEnv, loadServerEnv } from './index.js';

const VALID = {
  DATABASE_URL: 'postgres://app:pw@localhost:5432/growth_os',
  SESSION_COOKIE_SECRET: 'x'.repeat(32),
  ENCRYPTION_MASTER_KEY: 'y'.repeat(32),
};

describe('server configuration fails fast', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = loadServerEnv({ ...VALID });
    expect(env.APP_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('throws when a required variable is missing', () => {
    expect(() => loadServerEnv({ SESSION_COOKIE_SECRET: 'x'.repeat(32) })).toThrow(
      ConfigurationError,
    );
  });

  it('names every offending key so a misconfiguration is actionable', () => {
    try {
      loadServerEnv({});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const paths = (error as ConfigurationError).issues.map((i) => i.path);
      expect(paths).toContain('DATABASE_URL');
      expect(paths).toContain('SESSION_COOKIE_SECRET');
      expect(paths).toContain('ENCRYPTION_MASTER_KEY');
    }
  });

  it('never echoes the offending value — an invalid secret is still a secret', () => {
    const leaked = 'short-but-secret-value';
    try {
      loadServerEnv({ ...VALID, SESSION_COOKIE_SECRET: leaked });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(leaked);
      expect((error as Error).message).toContain('SESSION_COOKIE_SECRET');
    }
  });

  it('rejects a secret that is too short to be one', () => {
    expect(() => loadServerEnv({ ...VALID, SESSION_COOKIE_SECRET: 'tooshort' })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects a malformed URL and an out-of-range port', () => {
    expect(() => loadServerEnv({ ...VALID, DATABASE_URL: 'not-a-url' })).toThrow(
      ConfigurationError,
    );
    expect(() => loadServerEnv({ ...VALID, PORT: '70000' })).toThrow(ConfigurationError);
  });
});

describe('client configuration', () => {
  it('accepts only NEXT_PUBLIC_ keys', () => {
    const env = loadClientEnv({ NEXT_PUBLIC_APP_URL: 'https://app.example.com' });
    expect(env.NEXT_PUBLIC_APP_URL).toBe('https://app.example.com');
    expect(Object.keys(env).every((k) => k.startsWith('NEXT_PUBLIC_'))).toBe(true);
  });

  it('does not expose server-only keys even when they are present in the source', () => {
    const env = loadClientEnv({ ...VALID, NEXT_PUBLIC_APP_URL: 'https://app.example.com' });
    expect(JSON.stringify(env)).not.toContain('SESSION_COOKIE_SECRET');
    expect(JSON.stringify(env)).not.toContain(VALID.DATABASE_URL);
  });
});

describe('server-secret leak guard', () => {
  const fixture = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'gos-guard-'));
    for (const [name, content] of Object.entries(files)) {
      const full = join(dir, name);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    return dir;
  };

  it('flags a server-only key referenced from client code', () => {
    const dir = fixture({
      'page.tsx': 'export const k = process.env.SESSION_COOKIE_SECRET;\n',
    });
    const findings = findServerEnvLeaks([dir], dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.key).toBe('SESSION_COOKIE_SECRET');
  });

  it('flags bracket access as well as dot access', () => {
    const dir = fixture({
      'a.ts': "const k = process.env['DATABASE_URL'];\nexport default k;\n",
      'b.ts': 'const k = process.env["ENCRYPTION_MASTER_KEY"];\nexport default k;\n',
    });
    expect(
      findServerEnvLeaks([dir], dir)
        .map((f) => f.key)
        .sort(),
    ).toEqual(['DATABASE_URL', 'ENCRYPTION_MASTER_KEY']);
  });

  it('allows NEXT_PUBLIC_ keys', () => {
    const dir = fixture({ 'ok.tsx': 'export const u = process.env.NEXT_PUBLIC_APP_URL;\n' });
    expect(findServerEnvLeaks([dir], dir)).toEqual([]);
  });

  it('reports the file and line so the failure is actionable', () => {
    const dir = fixture({
      'x.ts': `const a = 1;\nconst b = process.env.DATABASE_URL;\nexport { a, b };\n`,
    });
    const [finding] = findServerEnvLeaks([dir], dir);
    expect(finding?.line).toBe(2);
    expect(finding?.file).toBe('x.ts');
  });
});
