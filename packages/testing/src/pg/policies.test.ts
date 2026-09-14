/**
 * db/policies/ is the canonical, reviewable statement of tenant isolation — the artefact a
 * reviewer or auditor reads instead of reconstructing the rules from migration history
 * (Phase 1 exit criterion: "a reviewer can verify isolation from db/policies/ alone").
 *
 * A document claiming to mirror the database is worthless unless something fails when it
 * stops mirroring it. These tests are that something. They compare each file's declared
 * canonical expressions against pg_policies in a freshly migrated database, in BOTH
 * directions: a policy whose file is stale fails, and a table with no file fails.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from './harness.js';
import { tenantScopedTables } from './structural.js';

let db: TestDatabase;
let admin: Client;

/** Locates db/policies by walking up, for the same reason migrationsDir() does. */
function policiesDir(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 10; depth++) {
    const candidate = join(dir, 'db', 'policies');
    try {
      readdirSync(candidate);
      return candidate;
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate db/policies from ${process.cwd()}`);
}

const DIR = resolve(policiesDir());

interface PolicyFile {
  readonly table: string;
  readonly using: string;
  readonly withCheck: string;
}

function readPolicyFiles(): PolicyFile[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((file) => {
      const text = readFileSync(join(DIR, file), 'utf8');
      const using = /--\s*canonical-using:\s*(.+)/.exec(text)?.[1]?.trim();
      const withCheck = /--\s*canonical-with-check:\s*(.+)/.exec(text)?.[1]?.trim();
      if (using === undefined || withCheck === undefined) {
        throw new Error(
          `${file} is missing a canonical-using or canonical-with-check marker. Every ` +
            'policy file must declare both so drift against the database is detectable.',
        );
      }
      return { table: file.replace(/\.sql$/, ''), using, withCheck };
    });
}

beforeAll(async () => {
  db = await acquireTestDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();
}, 120_000);

afterAll(async () => {
  await admin.end();
  await db.close();
  await stopSharedCluster();
});

describe('db/policies mirrors the database', () => {
  it('declares a canonical USING and WITH CHECK in every file', () => {
    expect(() => readPolicyFiles()).not.toThrow();
    expect(readPolicyFiles().length).toBeGreaterThan(0);
  });

  it('every documented policy matches the one actually installed', async () => {
    const files = readPolicyFiles();
    const live = await admin.query<{
      tablename: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT tablename, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'tenant_isolation'`,
    );
    const byTable = new Map(live.rows.map((r) => [r.tablename, r]));

    const drift: string[] = [];
    for (const file of files) {
      const row = byTable.get(file.table);
      if (row === undefined) {
        drift.push(`${file.table}: documented in db/policies but no policy in the database`);
        continue;
      }
      if (row.qual !== file.using) {
        drift.push(`${file.table} USING\n  file: ${file.using}\n  db:   ${row.qual}`);
      }
      if (row.with_check !== file.withCheck) {
        drift.push(
          `${file.table} WITH CHECK\n  file: ${file.withCheck}\n  db:   ${row.with_check}`,
        );
      }
    }
    expect(drift).toEqual([]);
  });

  /**
   * The direction that actually protects the property. Without this, adding a tenant table
   * and forgetting its policy file leaves isolation undocumented — and the review artefact
   * silently stops being complete.
   */
  it('every tenant-scoped table in the database has a policy file', async () => {
    const documented = new Set(readPolicyFiles().map((f) => f.table));
    const tables = await tenantScopedTables(db.pool);
    const undocumented = tables.filter((t) => !documented.has(t));
    expect(undocumented).toEqual([]);
  });
});
