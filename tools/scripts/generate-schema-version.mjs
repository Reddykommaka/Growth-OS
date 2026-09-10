#!/usr/bin/env node
/**
 * Generates the schema version the code expects.
 *
 * 12-devops-architecture.md §5: /readyz must compare the deployed schema against what the
 * running code expects, so a replica running old code against a newer schema — or worse,
 * new code against an un-migrated database — does not serve traffic.
 *
 * The constant is generated and CHECKED IN, then verified in CI. A value computed at
 * runtime from db/migrations would be useless in a container, which ships the application
 * without the migrations directory.
 *
 *   --check   exit non-zero if the checked-in file is stale
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS = resolve('db/migrations');
const TARGET = resolve('packages/platform/db/src/schema-version.ts');

const migrations = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const latest = migrations.at(-1);
if (latest === undefined) {
  console.error('No migrations found; cannot determine the expected schema version.');
  process.exit(1);
}

const contents = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node tools/scripts/generate-schema-version.mjs
//
// The migration this build of the application expects to be applied. /readyz refuses
// traffic when the database is BEHIND this version (12-devops-architecture.md §5).

/** The newest migration this build knows about. */
export const EXPECTED_SCHEMA_VERSION = '${latest}';

/** Every migration this build knows about, in application order. */
export const KNOWN_MIGRATIONS: readonly string[] = ${JSON.stringify(migrations, null, 2)};
`;

if (process.argv.includes('--check')) {
  // Compares VALUES, not bytes. The file is formatted by Biome after generation, so a
  // byte-for-byte comparison would fail on quote style alone and train people to ignore
  // this gate. What actually matters is whether the constants are stale.
  let current = '';
  try {
    current = readFileSync(TARGET, 'utf8');
  } catch {
    console.error(`${TARGET} does not exist. Run: node tools/scripts/generate-schema-version.mjs`);
    process.exit(1);
  }

  const declared = /EXPECTED_SCHEMA_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(current)?.[1];
  const listed = [...current.matchAll(/['"](\d{4}_[^'"]+\.sql)['"]/g)]
    .map((m) => m[1])
    .filter((name, index, all) => all.indexOf(name) === index && name !== declared)
    .concat(declared === undefined ? [] : [declared])
    .sort();

  const problems = [];
  if (declared !== latest) {
    problems.push(
      `EXPECTED_SCHEMA_VERSION is "${declared ?? '(missing)'}", newest migration is "${latest}"`,
    );
  }
  if (listed.join(',') !== migrations.join(',')) {
    problems.push(
      `KNOWN_MIGRATIONS is [${listed.join(', ')}], expected [${migrations.join(', ')}]`,
    );
  }

  if (problems.length > 0) {
    console.error(
      'packages/platform/db/src/schema-version.ts is stale:\n' +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\n\nA migration was added without regenerating it, so /readyz would accept a\n' +
        'database that is missing that migration. Run:\n\n' +
        '  node tools/scripts/generate-schema-version.mjs\n',
    );
    process.exit(1);
  }
  console.log(`schema-version: OK (${latest})`);
} else {
  writeFileSync(TARGET, contents);
  console.log(`schema-version: wrote ${latest}`);
}
