import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests only. The database-backed suites carry `.integration.test.ts` and run in
    // the integration stage, against a real cluster.
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
  },
});
