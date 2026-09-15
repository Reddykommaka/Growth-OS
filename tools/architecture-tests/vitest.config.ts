import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Spawning linters and a nested vitest run is slow; these are not unit tests.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    /**
     * LOAD-BEARING, not a performance setting.
     *
     * gates.test.ts WRITES throwaway component fixtures into packages/ui/src (vitest will
     * not find them anywhere else), while boundaries.test.ts READS the whole source tree
     * with dependency-cruiser, biome and the file-length check. Run in parallel, the reader
     * walks a fixture the writer has already deleted:
     *
     *   ENOENT: ... open '/…/packages/ui/src/__gate_<n>_<rand>.test.tsx'
     *
     * which dependency-cruiser reports by exiting non-zero with no stdout — surfacing as a
     * JSON parse error in an unrelated file. It reproduced in roughly two runs out of three
     * at --concurrency=4 and hid for a whole session at lower concurrency.
     *
     * Running the files one at a time removes the race by construction.
     */
    fileParallelism: false,
  },
});
