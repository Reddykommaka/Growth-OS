import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit only. The integration suites need a real cluster and run under their own config.
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', '**/node_modules/**'],
  },
});
