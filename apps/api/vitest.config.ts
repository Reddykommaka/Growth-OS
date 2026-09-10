import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        // NodeNext requires a .js extension on relative imports in source. Vite loads the
        // TypeScript sources, so the extension is mapped back here.
        find: /^(\.{1,2}\/.*)\.js$/,
        replacement: '$1.ts',
        // Scoped deliberately: an unscoped alias also rewrites dependencies' own internal
        // relative imports (pg's './cluster.js' became './cluster.ts' and failed to
        // resolve). Only rewrite when the importer is our source AND the .ts file exists.
        customResolver(source: string, importer: string | undefined) {
          if (importer === undefined || importer.includes('node_modules')) return null;
          const candidate = resolve(dirname(importer), source);
          return existsSync(candidate) ? candidate : null;
        },
      },
    ],
  },
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
