#!/usr/bin/env node
import { resolve } from 'node:path';
import { readMigrations } from '../../packages/testing/dist/pg/cluster.js';
/**
 * Migration job entrypoint.
 *
 * 12-devops-architecture.md §4: migrations are a DISCRETE pre-deploy job, run with the
 * migrator role, never on application boot. Boot-time migration means N replicas racing the
 * same DDL, and a bad migration takes the application down with it instead of failing one
 * job that can be inspected.
 *
 *   DATABASE_MIGRATOR_URL   connection string for growth_os_migrator (BYPASSRLS)
 *   --dry-run               report what would be applied and exit 0
 */
import { applyMigrations, currentSchemaVersion } from '../../packages/testing/dist/pg/migrate.js';

const url = process.env['DATABASE_MIGRATOR_URL'];
if (url === undefined || url === '') {
  console.error(
    'DATABASE_MIGRATOR_URL is not set.\n' +
      'Migrations run as growth_os_migrator, which is the only role with BYPASSRLS. The\n' +
      'application role must never be used here (06-identity-and-access.md §4).',
  );
  process.exit(1);
}

const dir = resolve(process.argv[2] ?? 'db/migrations');
const dryRun = process.argv.includes('--dry-run');

try {
  const current = await currentSchemaVersion(url).catch(() => null);
  const all = readMigrations(dir).map((m) => m.name);
  const pending = current === null ? all : all.slice(all.indexOf(current) + 1);

  console.log(`current: ${current ?? '(none applied)'}`);
  console.log(`pending: ${pending.length === 0 ? '(none)' : pending.join(', ')}`);

  if (dryRun) {
    console.log('dry run: nothing applied.');
    process.exit(0);
  }

  const result = await applyMigrations(url, dir);
  console.log(`applied: ${result.applied.length === 0 ? '(none)' : result.applied.join(', ')}`);
  console.log(`skipped: ${result.skipped.length} already-applied migration(s)`);
  console.log(`schema version is now ${await currentSchemaVersion(url)}`);
} catch (error) {
  console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  // A failed migration must stop the deploy. The previous release keeps serving, which is
  // safe because every migration is expand/contract and backward compatible.
  process.exit(1);
}
