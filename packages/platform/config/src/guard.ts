/**
 * Server-secret leak guard.
 *
 * 01-overview.md §3 principle 11: secrets never reach the client. Two mechanisms enforce
 * it — the schema split in ./schema.ts, and this static check, which scans client-reachable
 * source for references to server-only environment keys.
 *
 * Scanning source rather than the built bundle is deliberate: it fails in the editor and in
 * CI at the moment the reference is written, instead of after a bundler has already
 * inlined the value.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CLIENT_ENV_KEYS, SERVER_ENV_KEYS } from './schema.js';

export interface LeakFinding {
  readonly file: string;
  readonly line: number;
  readonly key: string;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', '.git']);
const SOURCE = /\.(ts|tsx|js|jsx|mts|mjs)$/;

/**
 * Files that legitimately reference server keys even though they sit under a client-ish
 * path: the schema itself, the loader, and this guard.
 */
const ALLOWLIST = [/packages[/\\]platform[/\\]config[/\\]src[/\\]/];

/** Server keys that are not also client keys. */
const SERVER_ONLY = SERVER_ENV_KEYS.filter((k) => !CLIENT_ENV_KEYS.includes(k));

export function findServerEnvLeaks(roots: readonly string[], cwd = process.cwd()): LeakFinding[] {
  const findings: LeakFinding[] = [];
  const patterns = SERVER_ONLY.map(
    (key) => [key, new RegExp(`process\\.env(?:\\.${key}\\b|\\[['"\`]${key}['"\`]\\])`)] as const,
  );

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!SOURCE.test(entry.name)) continue;
      const rel = relative(cwd, full).split(sep).join('/');
      if (ALLOWLIST.some((r) => r.test(rel))) continue;

      const lines = readFileSync(full, 'utf8').split('\n');
      lines.forEach((text, index) => {
        for (const [key, pattern] of patterns) {
          if (pattern.test(text)) findings.push({ file: rel, line: index + 1, key });
        }
      });
    }
  };

  for (const root of roots) {
    try {
      if (statSync(root).isDirectory()) walk(root);
    } catch {
      // A root that does not exist yet is not a failure.
    }
  }
  return findings;
}
