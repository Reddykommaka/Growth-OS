/**
 * Boundary-enforcement mechanism tests.
 *
 * 03-repository-structure.md §2 lists four independent mechanisms that keep module
 * boundaries intact. A mechanism nobody can violate is worth more than one everybody
 * agrees with — but only if it actually fires. These tests run each mechanism against
 * deliberately illegal fixtures and assert the violation IS reported.
 *
 * This suite exists because a misconfigured rule silently enforces nothing while
 * appearing green, which is worse than having no rule at all: it is believed.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../../..');
const FIXTURES = 'tools/architecture-tests/fixtures';

/**
 * stdout and stderr are kept separate: several of these tools write a human-readable
 * summary to stderr alongside machine-readable JSON on stdout, and concatenating them
 * corrupts the JSON.
 */
function run(cmd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const combined = (r: { stdout: string; stderr: string }) => `${r.stdout}${r.stderr}`;

const depcruise = (globs: string[]) =>
  run('./node_modules/.bin/depcruise', [
    '--config',
    '.dependency-cruiser.cjs',
    '--output-type',
    'json',
    ...globs,
  ]);

// ---------------------------------------------------------------------------
// Mechanism 1 — package.json "exports" maps
// ---------------------------------------------------------------------------
describe('mechanism 1: exports maps expose only a package public surface', () => {
  const resolves = (spec: string): boolean => {
    try {
      import.meta.resolve(spec);
      return true;
    } catch {
      return false;
    }
  };

  it.each([
    ['@growth-os/module-social/contracts', true],
    ['@growth-os/module-social/infrastructure', true],
  ])('%s resolves', (spec, expected) => {
    expect(resolves(spec)).toBe(expected);
  });

  it.each([
    '@growth-os/module-social',
    '@growth-os/module-social/domain',
    '@growth-os/module-social/application',
    '@growth-os/module-social/src/domain/index.js',
    '@growth-os/module-social/dist/domain/index.js',
  ])('%s is unreachable', (spec) => {
    expect(resolves(spec)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mechanism 3 — dependency-cruiser architectural rules
// ---------------------------------------------------------------------------
describe('mechanism 3: dependency-cruiser rejects architectural violations', () => {
  const result = depcruise([`${FIXTURES}/**/*.ts`]);
  const report = JSON.parse(result.stdout) as {
    summary: {
      totalCruised: number;
      violations: { rule: { name: string }; from: string; to: string }[];
    };
  };
  const fired = new Set(report.summary.violations.map((v) => v.rule.name));

  it('actually parses the fixtures (guards against a config that cruises nothing)', () => {
    // dependency-cruiser reports "no violations found" when it parses zero modules, which
    // is indistinguishable from success. It cruised 0 modules for a real configuration
    // error during Phase 0; this assertion makes that failure loud instead of silent.
    expect(report.summary.totalCruised).toBeGreaterThan(10);
  });

  it.each([
    'domain-imports-nothing-above-it',
    'application-must-not-import-infrastructure',
    'apps-import-contracts-only',
    'ui-must-not-import-business-modules',
    'platform-must-not-import-modules',
    'no-circular',
  ])('rule %s fires on its fixture', (rule) => {
    expect(fired).toContain(rule);
  });
});

describe('mechanism 3: the real source tree is clean', () => {
  it('has no architectural violations', () => {
    // Bare directories, not globs: dependency-cruiser does its own scanning and covers
    // exactly the tracked sources. A recursive shell glob instead walks pnpm's workspace
    // symlinks under node_modules, reporting the same file many times and taking minutes.
    const result = depcruise(['packages', 'apps']);
    const report = JSON.parse(result.stdout) as {
      summary: { totalCruised: number; error: number; violations: { rule: { name: string } }[] };
    };
    expect(report.summary.totalCruised).toBeGreaterThan(50);
    expect(report.summary.violations.filter((v) => v.rule.name !== 'no-orphan-source')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mechanism 4 — Biome rules (banned imports, any, non-null assertion)
// ---------------------------------------------------------------------------
describe('mechanism 4: biome rejects banned imports and unsafe syntax', () => {
  // The repository config excludes the fixtures (they must stay illegal). Lint them with
  // the same rules minus the tools/ relaxation.
  const cfgDir = mkdtempSync(join(tmpdir(), 'gos-biome-'));
  const base = JSON.parse(
    execFileSync('cat', ['biome.json'], { cwd: REPO, encoding: 'utf8' }),
  ) as Record<string, any>;
  base.vcs = { enabled: false };
  base.files.includes = ['**', '!**/node_modules', '!**/dist'];
  base.overrides = base.overrides.filter(
    (o: { includes: string[] }) => !o.includes.includes('tools/**'),
  );
  const cfgFile = join(cfgDir, 'biome.json');
  writeFileSync(cfgFile, JSON.stringify(base));

  const result = run('./node_modules/.bin/biome', [
    'lint',
    `--config-path=${cfgFile}`,
    '--reporter=json',
    FIXTURES,
  ]);
  const diagnostics = (
    JSON.parse(result.stdout) as {
      diagnostics: { category: string; location: { path: string } }[];
    }
  ).diagnostics;
  const found = new Set(
    diagnostics.map((d) => `${d.location.path.split('fixtures/')[1]}::${d.category}`),
  );

  it('parses the fixtures at all', () => {
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it.each([
    ['apps/api/src/banned-model-sdk.ts', 'lint/style/noRestrictedImports'],
    ['packages/modules/social/src/domain/banned-orm-import.ts', 'lint/style/noRestrictedImports'],
    [
      'packages/modules/social/src/application/banned-redis-import.ts',
      'lint/style/noRestrictedImports',
    ],
    ['biome/explicit-any.ts', 'lint/suspicious/noExplicitAny'],
    ['biome/non-null-assertion.ts', 'lint/style/noNonNullAssertion'],
  ])('%s is rejected by %s', (file, category) => {
    expect([...found]).toContain(`${file}::${category}`);
  });
});

describe('mechanism 4: the real source tree is clean', () => {
  it('passes biome check', () => {
    const result = run('./node_modules/.bin/biome', ['check', '.']);
    expect(result.code, combined(result)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Compiler-enforced rules (tsc catches what lint cannot)
// ---------------------------------------------------------------------------
describe('typescript strictness rejects unsafe code', () => {
  const compile = (fixture: string) =>
    run('./node_modules/.bin/tsc', [
      '--noEmit',
      '--ignoreConfig',
      '--strict',
      '--noImplicitAny',
      '--noUncheckedIndexedAccess',
      '--target',
      'es2023',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      `${FIXTURES}/${fixture}`,
    ]);

  it('rejects an implicit any parameter', () => {
    const r = compile('tsc/implicit-any.ts');
    expect(r.code).not.toBe(0);
    expect(combined(r)).toMatch(/implicitly has an 'any' type/);
  });

  it('rejects unchecked indexed access', () => {
    const r = compile('tsc/unchecked-index.ts');
    expect(r.code).not.toBe(0);
    expect(combined(r)).toMatch(/undefined/);
  });
});

// ---------------------------------------------------------------------------
// File-length cap
// ---------------------------------------------------------------------------
describe('file-length cap', () => {
  it('rejects a file over the cap', () => {
    const r = run('node', ['tools/scripts/check-file-size.mjs', `${FIXTURES}/biome`]);
    expect(r.code).toBe(1);
    expect(combined(r)).toMatch(/too-long\.ts/);
  });

  it('the real source tree is under the cap', () => {
    const r = run('node', ['tools/scripts/check-file-size.mjs', 'apps', 'packages']);
    expect(r.code, combined(r)).toBe(0);
  });
});
