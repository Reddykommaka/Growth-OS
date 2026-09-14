/**
 * Proves the migration lint rejects each violation it claims to catch, and stays silent on
 * correct SQL.
 *
 * Exit criterion #5 (18-phase-0-plan.md): a migration with float money, a missing RLS
 * policy, an unindexed FK or a non-timestamptz timestamp fails CI for the right reason.
 *
 * The positive control matters as much as the negative ones: a lint that flags everything
 * is noise, and noise gets ignored.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../../..');
const BAD = 'tools/architecture-tests/fixtures/migrations-bad';
const GOOD = 'tools/architecture-tests/fixtures/migrations-good';

function lint(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', ['tools/scripts/lint-migrations.mjs', dir], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('migration lint rejects violations', () => {
  const result = lint(BAD);

  it('exits non-zero', () => {
    expect(result.code).toBe(1);
  });

  it.each([
    ['timestamptz-only', '0002_naive_timestamp.sql'],
    ['integer-money', '0003_float_money.sql'],
    ['no-native-enum', '0004_native_enum.sql'],
    ['concurrent-index', '0005_blocking_index.sql'],
    ['no-blocking-alter', '0006_blocking_alter.sql'],
    ['no-drop-without-note', '0010_undocumented_drop.sql'],
  ])('rule %s fires on %s', (rule, file) => {
    expect(result.out).toContain(`[${rule}]`);
    expect(result.out).toContain(file);
  });

  it('catches a tenant-scoped table with no RLS', () => {
    expect(result.out).toContain('bad_tenant_table: RLS not ENABLEd');
    expect(result.out).toContain('bad_tenant_table: RLS not FORCEd');
    expect(result.out).toContain('bad_tenant_table: no policy');
  });

  it('catches a policy with no explicit WITH CHECK', () => {
    expect(result.out).toMatch(/half_secured: policy has no explicit WITH CHECK/);
  });

  it('catches a foreign key with no covering index', () => {
    expect(result.out).toContain('parent_id references parents with no covering index');
  });

  it('explains each failure with its architectural reason, not just a rule name', () => {
    // A lint message that names a rule but not the reason gets worked around instead of fixed.
    expect(result.out).toContain('ADR-0012');
    expect(result.out).toContain('05-data-architecture.md');
    expect(result.out).toContain('06-identity-and-access.md');
  });
});

describe('migration lint stays silent on correct SQL', () => {
  it('accepts the positive-control fixtures', () => {
    const result = lint(GOOD);
    expect(result.code, result.out).toBe(0);
  });

  it('accepts the real migrations', () => {
    const result = lint('db/migrations');
    expect(result.code, result.out).toBe(0);
  });
});

/**
 * The concurrent-index rule was generalised during Phase 1 from "exempt file 0001" to
 * "exempt an index on a table created in this same migration".
 *
 * The reason the rule gives for itself is that a blocking build on a *large* table is an
 * outage. A table created in the same file has no rows — and CONCURRENTLY is in fact
 * illegal there, because the runner applies each migration inside BEGIN/COMMIT. Pinning the
 * exemption to a filename made every schema-creating migration after the first unwritable.
 *
 * These two cases are what stop that generalisation from becoming a hole.
 */
describe('concurrent-index exemption follows the table, not the filename', () => {
  const dir = 'tools/architecture-tests/fixtures/migrations-concurrency';

  it('allows a non-concurrent index on a table created in the same migration', () => {
    const out = lint(`${dir}/same-file`);
    expect(out.out).not.toContain('[concurrent-index]');
    expect(out.code).toBe(0);
  });

  it('still rejects a non-concurrent index on a pre-existing table — even in 0001', () => {
    const out = lint(`${dir}/pre-existing`);
    expect(out.out).toContain('[concurrent-index]');
    expect(out.out).toContain('on established_table');
    expect(out.code).toBe(1);
  });
});
