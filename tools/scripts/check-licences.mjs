#!/usr/bin/env node
/**
 * Licence gate (02-technology-stack.md §8).
 *
 * Copyleft licences are blocked: this is a commercial product, and a strong-copyleft
 * dependency in the application graph creates a distribution obligation nobody chose.
 */
import { readFileSync } from 'node:fs';

const BLOCKED = [/^GPL/i, /^AGPL/i, /^SSPL/i, /^OSL/i, /^EUPL/i, /^CC-BY-NC/i];

const raw = JSON.parse(readFileSync(process.argv[2] ?? 'licences.json', 'utf8'));
const entries = Array.isArray(raw)
  ? raw
  : Object.entries(raw).flatMap(([l, ps]) => ps.map((p) => ({ ...p, license: l })));

const offenders = entries.filter((e) => BLOCKED.some((r) => r.test(String(e.license ?? ''))));

if (offenders.length > 0) {
  console.error('Blocked licences found:\n');
  for (const o of offenders) console.error(`  ${o.name ?? '?'}@${o.version ?? '?'} — ${o.license}`);
  console.error('\nA strong-copyleft dependency creates a distribution obligation. Replace it,');
  console.error('or record an exception with legal sign-off in docs/adr/.');
  process.exit(1);
}
console.log(`licences: OK (${entries.length} packages checked)`);
