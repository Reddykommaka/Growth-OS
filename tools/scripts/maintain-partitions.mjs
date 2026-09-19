#!/usr/bin/env node
/**
 * Partition maintenance job entrypoint.
 *
 * 05-data-architecture.md §7: "a scheduled job pre-creates partitions 3 months ahead". This
 * is that job. It runs as a discrete step immediately after the migration job, with the same
 * credential and the same failure semantics — a failure stops the deploy.
 *
 * ADR-0021 records why this lives in the deploy pipeline rather than in a BullMQ worker
 * (the worker connects as growth_os_app, which must never hold CREATE on the schema), and
 * why it deliberately detaches, archives and drops nothing.
 *
 *   DATABASE_MIGRATOR_URL   connection string for growth_os_migrator
 *   --check                 report headroom and exit non-zero if a table is short;
 *                           creates nothing. For a monitor, not for a deploy.
 */
import {
  insufficientHeadroom,
  MINIMUM_HEADROOM_MONTHS,
  runPartitionMaintenance,
  withMaintenanceConnection,
} from '../../packages/platform/db/dist/partition-maintenance.js';

const url = process.env['DATABASE_MIGRATOR_URL'];
if (url === undefined || url === '') {
  console.error(
    'DATABASE_MIGRATOR_URL is not set.\n' +
      'Partition maintenance creates tables and must run as growth_os_migrator. The\n' +
      'application role holds no EXECUTE on the ensure functions and must not\n' +
      '(06-identity-and-access.md §4).',
  );
  process.exit(1);
}

let failed = false;

try {
  const result = await withMaintenanceConnection(url, (client) =>
    runPartitionMaintenance(client, { checkOnly: process.argv.includes('--check') }),
  );

  if (result.unregistered.length > 0) {
    console.error(
      `Partitioned tables with no maintenance registration: ${result.unregistered.join(', ')}.\n` +
        'Register each one in partition_maintenance, in the migration that created it, ' +
        'naming the function that creates AND hardens its partitions. Nothing pre-creates ' +
        'partitions for an unregistered table, so it begins rejecting inserts in the month ' +
        'its last pre-created partition ends.',
    );
    failed = true;
  }

  for (const [table, partitions] of Object.entries(result.ensured)) {
    console.log(`${table}: ${partitions.join(', ')}`);
  }
  for (const entry of result.headroom) {
    console.log(`${entry.parentTable}: ${entry.monthsAhead} month(s) of headroom`);
  }

  const short = insufficientHeadroom(result.headroom);
  if (short.length > 0) {
    console.error(
      `Below ${MINIMUM_HEADROOM_MONTHS} months of headroom: ` +
        `${short.map((h) => h.parentTable).join(', ')}. A table at -1 has no partition ` +
        'covering now() and is already refusing writes.',
    );
    failed = true;
  }
} catch (error) {
  console.error(
    `Partition maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  failed = true;
}

// Same posture as the migration job: a failure stops the deploy. The previous release keeps
// serving, and it keeps serving correctly for as long as partitions remain — which is what
// makes failing here cheap and failing silently expensive.
process.exit(failed ? 1 : 0);
