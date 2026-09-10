import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Each spec shells out to a linter; they are slow but independent.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
