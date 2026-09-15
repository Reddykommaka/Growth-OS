/**
 * OAuth safety escapes must not reach production.
 *
 * `allowInsecureIssuer` permits plain HTTP to an OIDC issuer. It exists solely so the test
 * suite can run a loopback issuer, and it is exactly the kind of flag that migrates from a
 * test into a config file and then into production — at which point the ID token has no
 * integrity guarantee at all and the entire federation is forgeable by anyone on the path.
 *
 * So it is policed structurally rather than by review.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../../..');

function sourceFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'apps', 'packages'],
    { cwd: REPO, encoding: 'utf8' },
  );
  return out.split('\n').filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
}

/** The adapter that defines the option, and may therefore mention it. */
const ADAPTER = 'packages/modules/identity/src/infrastructure/oidc-provider.ts';

describe('the insecure-issuer escape hatch is confined to tests', () => {
  const files = sourceFiles();

  it('finds the source tree', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(ADAPTER);
  });

  it('is only SET to true in test files', () => {
    const offenders = files.filter((file) => {
      if (/\.test\.tsx?$/.test(file)) return false;
      if (file.includes('__testing__')) return false;
      const text = readFileSync(resolve(REPO, file), 'utf8');
      // A literal `allowInsecureIssuer: true` anywhere outside a test is the failure.
      return /allowInsecureIssuer\s*:\s*true/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('is mentioned outside tests only by the adapter that defines it', () => {
    const mentions = files.filter((file) => {
      if (/\.test\.tsx?$/.test(file)) return false;
      if (file.includes('__testing__')) return false;
      if (file === ADAPTER) return false;
      return /allowInsecureIssuer/.test(readFileSync(resolve(REPO, file), 'utf8'));
    });
    expect(mentions).toEqual([]);
  });

  /**
   * The adapter must keep gating on the flag. If the guard were removed, insecure requests
   * would be permitted unconditionally and the option above would become decorative.
   */
  it('the adapter still gates insecure requests behind the flag', () => {
    const text = readFileSync(resolve(REPO, ADAPTER), 'utf8');
    expect(text).toMatch(/config\.allowInsecureIssuer === true/);
  });

  /** PKCE must be S256. `plain` sends the verifier itself, defeating the mechanism. */
  it('the adapter requests S256 PKCE and never plain', () => {
    const text = readFileSync(resolve(REPO, ADAPTER), 'utf8');
    expect(text).toMatch(/code_challenge_method:\s*'S256'/);
    expect(text).not.toMatch(/code_challenge_method:\s*'plain'/);
  });

  /**
   * Login must not persist provider tokens. Storing them creates a credential to protect for
   * no benefit, since we never call the provider again on the user's behalf.
   */
  it('no OAuth column stores a provider access or refresh token', () => {
    const migrations = execFileSync('git', ['ls-files', 'db/migrations'], {
      cwd: REPO,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => f.endsWith('.sql'));
    expect(migrations.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const file of migrations) {
      const sql = readFileSync(resolve(REPO, file), 'utf8').replace(/--[^\n]*/g, '');
      if (/\b(access_token|refresh_token|id_token)\b/.test(sql)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
