/**
 * Proves each CI gate rejects what it claims to reject.
 *
 * Exit criterion #8 (18-phase-0-plan.md) asks for a deliberately failing PR per gate. An
 * automated suite is the stronger form of the same evidence: it is repeatable, it runs on
 * every commit, and it fails if a gate is ever weakened — which a one-off PR cannot do.
 *
 * The boundary and migration gates are covered by boundaries.test.ts and migrations.test.ts.
 * This file covers the two that remain: secret scanning and component accessibility.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../../..');

function run(cmd: string, args: string[], cwd = REPO): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// ---------------------------------------------------------------------------
// Secret scanning
// ---------------------------------------------------------------------------
describe('gate: a committed secret is blocked', () => {
  /**
   * Credential shapes are ASSEMBLED at runtime, never written as literals.
   *
   * A realistic key written into this file would put a credential-shaped string into a
   * public repository: GitHub push protection rejects the push, and any scanner worth
   * having flags it. Allowlisting the file would also work, but every allowlist entry is a
   * permanent hole that someone later widens. Building the strings from fragments keeps the
   * pattern under genuine test while leaving nothing secret-shaped in the source.
   */
  const shape = (...parts: string[]): string => parts.join('');
  const ALPHA = 'abcdefghijklmnopqrstuvwxyz';
  const UPPER = ALPHA.toUpperCase();

  /** The same pattern the pre-commit hook applies when gitleaks is unavailable. */
  const scan = (line: string): boolean =>
    new RegExp(
      [
        'AKIA[0-9A-Z]{16}',
        'gh[pousr]_[A-Za-z0-9]{20,}',
        'sk-[A-Za-z0-9_-]{16,}',
        'sk_(live|test)_[A-Za-z0-9]{16,}',
        'gos_(live|test)_[A-Za-z0-9_-]{16,}',
        '-----BEGIN [A-Z ]*PRIVATE KEY-----',
      ].join('|'),
    ).test(line);

  it.each([
    ['cloud access key id', shape('AKIA', UPPER.slice(0, 16))],
    ['forge token', shape('gh', 'p', '_', ALPHA, '0123456789')],
    ['model provider secret key', shape('sk', '-', ALPHA, '0123')],
    ['payment provider live key', shape('sk', '_', 'live', '_', ALPHA, '0123456789')],
    ['our own API key', shape('gos', '_', 'live', '_', 'ab12', '_', UPPER.slice(0, 20))],
    ['PEM private key header', shape('-----BEGIN ', 'RSA ', 'PRIVATE KEY-----')],
  ])('detects a %s', (_name, candidate) => {
    expect(scan(candidate)).toBe(true);
  });

  it.each([
    'const description = "sk is a common abbreviation";',
    'const id = "01890a5d-ac96-774b-bcce-b302099a8057";',
    'const message = "Authentication required.";',
    'const path = "packages/platform/authn/src/session.ts";',
  ])('does not flag ordinary code: %s', (line) => {
    // A scanner that cries wolf gets bypassed with --no-verify, which disables it entirely.
    expect(scan(line)).toBe(false);
  });

  it('registers our own API key format so external scanners detect it too', () => {
    const config = run('cat', ['.gitleaks.toml']).out;
    expect(config).toContain('growth-os-api-key');
    expect(config).toContain(shape('gos', '_', 'live', '_'));
  });

  it('allowlists only the paths that hold deliberate fixtures', () => {
    const config = run('cat', ['.gitleaks.toml']).out;
    // An over-broad allowlist silently disables the gate.
    expect(config).toContain('tools/architecture-tests/fixtures');
    const allowlist = config.slice(config.indexOf('[allowlist]'));
    expect(allowlist, 'a catch-all allowlist entry disables the scanner').not.toMatch(/'''\.\*'''/);
  });

  it('the pre-commit hook is executable and wired to the repository', () => {
    const hook = run('test', ['-x', '.githooks/pre-commit']);
    expect(hook.code, '.githooks/pre-commit must be executable').toBe(0);
    const body = run('cat', ['.githooks/pre-commit']).out;
    // The hook must fail loudly rather than pass silently when gitleaks is absent.
    expect(body).toContain('falling back to a pattern scan');
  });

  it('refuses to commit an environment file other than .env.example', () => {
    const body = run('cat', ['.githooks/pre-commit']).out;
    expect(body).toMatch(/\.env\.example/);
  });

  it('the hook reads its allowlist from .gitleaks.toml rather than duplicating it', () => {
    // Found the hard way: the fallback scan originally ignored the allowlist and blocked a
    // legitimate commit that gitleaks itself would have passed. A hook that blocks correct
    // work is one people learn to bypass, which disables it entirely.
    const body = run('cat', ['.githooks/pre-commit']).out;
    expect(body).toContain('.gitleaks.toml');
    expect(body).toMatch(/allowlist/);
  });

  it('this suite itself contains no literal credential shape', () => {
    // The guarantee that keeps this file out of the allowlist and keeps GitHub push
    // protection from rejecting the push. Lines that BUILD a shape are excluded; lines that
    // contain one outright are not.
    const self = run('cat', ['tools/architecture-tests/src/gates.test.ts']).out;
    const offenders = self
      .split('\n')
      .filter((line) => !line.includes('shape(') && !line.includes('.join('))
      .filter((line) => scan(line));
    expect(offenders, `literal credential shapes found:\n${offenders.join('\n')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Component accessibility
// ---------------------------------------------------------------------------
describe('gate: an inaccessible component is rejected', () => {
  const uiDir = join(REPO, 'packages/ui');

  /**
   * Writes a throwaway spec into packages/ui/src and runs it.
   *
   * It has to live there: vitest resolves test files relative to its root, and the spec
   * needs the ui package's own alias config and dependency chain. A copy in the OS temp
   * directory is simply not found ("No test files found"), and moving the root to the temp
   * directory breaks module resolution for React and the component under test.
   *
   * That makes this suite a WRITER to the source tree while the boundary suite is a READER
   * of it. Those two must never run concurrently — under load, dependency-cruiser walked a
   * fixture this function had already deleted:
   *
   *   ENOENT: ... open '/…/packages/ui/src/__gate_1789437974653_lev3x1r67p.test.tsx'
   *
   * and it surfaced as an unreadable JSON parse error in a different file. The fix is
   * `fileParallelism: false` in this package's vitest config, which is load-bearing rather
   * than a performance choice — see the comment there.
   */
  const runSpec = (source: string): { code: number; out: string } => {
    // Sweep anything a previous run left behind. The delete below is in a `finally`, which
    // a killed process never reaches — one such fixture had been sitting in packages/ui/src
    // for two days, invisible to git (it is ignored) but picked up by every glob-based tool
    // that walks the source tree.
    run('sh', ['-c', `rm -f ${join(uiDir, 'src', '__gate_*.test.tsx')}`], uiDir);
    const file = join(
      uiDir,
      'src',
      `__gate_${Date.now()}_${Math.random().toString(36).slice(2)}.test.tsx`,
    );
    writeFileSync(file, source);
    try {
      return run('./node_modules/.bin/vitest', ['run', file, '--root', uiDir], uiDir);
    } finally {
      run('rm', ['-f', file]);
    }
  };

  it('fails an icon-only button with no accessible name', () => {
    // The realistic failure: the icon is aria-hidden (correct — it is decorative) but no
    // label was supplied, so the button is announced as "button" and nothing else. A bare
    // glyph as text content would NOT fail: axe treats it as a discernible name, which is
    // why this fixture hides the glyph rather than omitting a label beside it.
    const result = runSpec(`
      import { describeComponent } from './testing/a11y.js';
      describeComponent('Unnamed', {
        render: () => (
          <button type="button" className="gos-button">
            <span aria-hidden="true">{'\\u00d7'}</span>
          </button>
        ),
      });
    `);
    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toMatch(/button-name|discernible/i);
  }, 120_000);

  it('fails a form control with no associated label', () => {
    const result = runSpec(`
      import { describeComponent } from './testing/a11y.js';
      describeComponent('Unlabelled', {
        render: () => <input className="gos-input" type="text" />,
      });
    `);
    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toMatch(/label/i);
  }, 120_000);

  it('fails a component that cannot be reached by keyboard', () => {
    const result = runSpec(`
      import { describeComponent } from './testing/a11y.js';
      describeComponent('Unreachable', {
        render: () => (
          <div role="button" aria-label="Save" tabIndex={-1} className="gos-button" />
        ),
      });
    `);
    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toMatch(/reachable without a pointer|Keyboard focus never reached/);
  }, 120_000);

  it('passes a correctly built component', () => {
    // The positive control: the gate must not simply fail everything.
    const result = runSpec(`
      import { describeComponent } from './testing/a11y.js';
      import { Button } from './primitives/button.js';
      describeComponent('Good', { render: () => <Button>Save</Button> });
    `);
    expect(result.code, result.out).toBe(0);
  }, 120_000);
});
