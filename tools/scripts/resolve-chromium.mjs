#!/usr/bin/env node
/**
 * Prints the path to the pre-provisioned Chromium.
 *
 * 00-assessment.md §2: browsers are provisioned at PLAYWRIGHT_BROWSERS_PATH and must never
 * be downloaded at test time. The build id changes between images, so it is discovered
 * rather than hard-coded.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '/opt/pw-browsers';
if (!existsSync(root)) process.exit(0); // Let Playwright use its own resolution.

const dir = readdirSync(root)
  .filter((d) => /^chromium-\d+$/.test(d))
  .sort()
  .at(-1);
if (dir === undefined) process.exit(0);

for (const candidate of [
  'chrome-linux/chrome',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
]) {
  const full = join(root, dir, candidate);
  if (existsSync(full)) {
    process.stdout.write(full);
    break;
  }
}
