#!/usr/bin/env node
/**
 * File-length cap (03-repository-structure.md §5: "Do not create giant files").
 *
 * Biome has no max-lines-per-file rule, so this is enforced here and asserted by
 * tools/architecture-tests/src/boundaries.test.ts.
 *
 * Usage: node tools/scripts/check-file-size.mjs [rootDir...]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const MAX_LINES = 400;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', '.git']);
const SOURCE = /\.(ts|tsx|mts|cts)$/;
// Generated or vendored files are exempt; deliberately-illegal fixtures are checked by
// the architecture test suite with its own expectations, not by the repository-wide run.
const EXEMPT = [/\.d\.ts$/, /(^|[/\\])generated([/\\]|$)/];

export function findOversizedFiles(roots, { maxLines = MAX_LINES, cwd = process.cwd() } = {}) {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!SOURCE.test(entry.name)) continue;
      const rel = relative(cwd, full).split(sep).join('/');
      if (EXEMPT.some((r) => r.test(rel))) continue;
      const lines = readFileSync(full, 'utf8').split('\n').length;
      if (lines > maxLines) offenders.push({ file: rel, lines });
    }
  };
  for (const root of roots) {
    try {
      if (statSync(root).isDirectory()) walk(root);
    } catch {
      // A root that does not exist yet is not a failure.
    }
  }
  return offenders;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).pop());
if (isMain) {
  const roots = process.argv.slice(2);
  const offenders = findOversizedFiles(roots.length ? roots : ['apps', 'packages']);
  if (offenders.length > 0) {
    console.error(`File-length cap is ${MAX_LINES} lines. Offenders:`);
    for (const o of offenders) console.error(`  ${o.file} — ${o.lines} lines`);
    console.error('\nSplit the file. A large file hides business logic and blocks review.');
    process.exit(1);
  }
  console.log(`file-size: OK (cap ${MAX_LINES} lines)`);
}
