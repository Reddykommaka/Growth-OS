/**
 * Structural guarantee 4 from 06-identity-and-access.md §4:
 *
 *   "A test asserts no application code path issues session-level SET for tenant context."
 *
 * This is a STATIC check, and it has to be, because the failure it prevents is invisible at
 * runtime in a single-tenant test: a session-level `SET app.organization_id` behaves
 * identically to `SET LOCAL` until a transaction-mode pooler recycles the connection to a
 * different tenant. By then it is a cross-tenant data breach, in production, under load.
 *
 * So the rule is enforced on the source rather than observed in behaviour, and the single
 * sanctioned implementation is @growth-os/db's withTenant.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../../..');

/**
 * Every TypeScript source file under apps/ and packages/, TRACKED OR NOT.
 *
 * `--others --exclude-standard` matters: a check that only sees committed files cannot
 * fail on the file being added right now, which is precisely when it needs to.
 */
function sourceFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'apps', 'packages'],
    { cwd: REPO, encoding: 'utf8' },
  );
  return out.split('\n').filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
}

/** The one APPLICATION module permitted to write tenant settings. */
const SANCTIONED = 'packages/platform/db/src/tenant-context.ts';

/**
 * The test harness drives the database directly — seeding fixtures, probing policies,
 * asserting fail-closed behaviour with no context at all. That is its entire purpose, and
 * it never runs behind a pooler. It is exempt from the "one module only" rule but NOT from
 * the is_local rule below, which applies to every file without exception.
 */
const HARNESS = 'packages/testing/';

describe('tenant context is only ever transaction-scoped', () => {
  const files = sourceFiles();

  it('finds the source tree (guards against a glob that matches nothing)', () => {
    // Without this, a broken glob would make every assertion below vacuously true — the
    // same "green but inert" failure the boundary suite guards against.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(SANCTIONED);
  });

  it('no code path issues a session-level SET for an app.* setting', () => {
    // Matches `SET app.foo` but not `SET LOCAL app.foo`.
    const sessionLevelSet = /\bSET\s+(?!LOCAL\b)app\./i;
    const offenders = files.filter((file) =>
      sessionLevelSet.test(readFileSync(resolve(REPO, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('only the sanctioned module writes tenant settings, and only with is_local => true', () => {
    // set_config(name, value, is_local). The third argument must be `true`; `false` is a
    // session-level SET wearing a different hat, and reads as innocuous in review.
    const setConfig = /set_config\s*\(/i;
    const offenders: string[] = [];
    for (const file of files) {
      if (file === SANCTIONED) continue;
      if (file.startsWith(HARNESS)) continue;
      // Test files drive the database directly to build fixtures and probe policies; they
      // are not an application code path and never run against a pooler.
      if (/\.test\.tsx?$/.test(file)) continue;
      const text = readFileSync(resolve(REPO, file), 'utf8');
      if (setConfig.test(text) && /app\./.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The rule with NO exemptions. `set_config(name, value, false)` is a session-level SET
   * wearing a different hat — it reads as innocuous in review and leaks across a pooled
   * connection exactly like the bare SET form. Every file is checked, harness included.
   */
  it('NOTHING anywhere passes is_local => false for an app.* setting', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(resolve(REPO, file), 'utf8');
      if (!/app\./.test(text)) continue;
      if (/set_config\s*\([^)]*,\s*false\s*\)/i.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('the sanctioned module does use the local form, so the rule is not passing by absence', () => {
    const text = readFileSync(resolve(REPO, SANCTIONED), 'utf8');
    expect(text).toMatch(/set_config\(\$1,\s*\$2,\s*true\)/);
  });
});

/**
 * `withOrganizationScope` is the one function that claims organization-wide workspace reach
 * without an actor having earned it (migration 0007). It exists because the actor-context
 * resolver has a genuine bootstrap problem: the accessible set is computed by reading the
 * team→workspace topology, so resolution cannot run inside a policy that demands the set.
 *
 * Its safety rests entirely on being narrow — one function, one caller, reading ids and
 * team ids and returning a computed set rather than rows. That is a property of the call
 * graph, so it is asserted against the call graph. A second caller is how a bootstrap
 * primitive quietly becomes a way to see the whole tenant.
 */
describe('organization-wide scope is claimed in exactly one place', () => {
  const files = sourceFiles();
  const DEFINITION = 'packages/platform/db/src/tenant-context.ts';
  const RESOLVER = 'packages/modules/organization/src/infrastructure/actor-resolver.ts';

  it('is defined only in the unit of work', () => {
    const definers = files.filter(
      (file) =>
        file !== DEFINITION &&
        /export\s+async\s+function\s+withOrganizationScope/.test(
          readFileSync(resolve(REPO, file), 'utf8'),
        ),
    );
    expect(definers).toEqual([]);
  });

  it('is called only by the actor-context resolver', () => {
    const callers = files.filter((file) => {
      if (file === DEFINITION) return false;
      // Tests may drive it directly; they are not an application code path.
      if (/\.test\.tsx?$/.test(file)) return false;
      return /\bwithOrganizationScope\s*\(/.test(readFileSync(resolve(REPO, file), 'utf8'));
    });
    expect(callers).toEqual([RESOLVER]);
  });

  it('nothing else writes the workspace scope setting', () => {
    const offenders = files.filter((file) => {
      if (file === DEFINITION) return false;
      if (/\.test\.tsx?$/.test(file)) return false;
      const text = readFileSync(resolve(REPO, file), 'utf8');
      // A WRITE, not a mention. The setting name appears in doc comments across the
      // codebase — that is documentation, and flagging it trains people to ignore this
      // check. Only set_config combined with the name is a write.
      return /set_config\s*\(/.test(text) && /['"`]app\.workspace_scope['"`]/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
