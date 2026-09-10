#!/usr/bin/env node
/**
 * Fails the build if client-reachable source references a server-only environment key
 * (01-overview.md §3 principle 11).
 */
import { findServerEnvLeaks } from '../../packages/platform/config/dist/guard.js';

const roots = process.argv.slice(2);
const findings = findServerEnvLeaks(roots.length ? roots : ['apps/web/src', 'packages/ui/src']);

if (findings.length > 0) {
  console.error('Server-only environment variables referenced in client-reachable code:\n');
  for (const f of findings) console.error(`  ${f.file}:${f.line} — ${f.key}`);
  console.error(
    '\nMove the read to a server module, or expose a NEXT_PUBLIC_ value through clientEnvSchema.',
  );
  process.exit(1);
}
console.log('client-env: OK (no server-only keys referenced from client code)');
