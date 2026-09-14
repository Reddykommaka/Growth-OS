import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // A cold run bootstraps a PostgreSQL cluster.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // The harness memoises one cluster per process; parallel forks would each start one.
    fileParallelism: false,
  },
});
