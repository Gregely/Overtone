import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const shared = fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url));
const core = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));
const coreTesting = fileURLToPath(new URL('./packages/core/src/testing/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against package sources directly; no build step needed.
    alias: { '@overtone/shared': shared, '@overtone/core/testing': coreTesting, '@overtone/core': core },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['packages/*/src/**/*.test.ts', 'apps/server/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['apps/web/src/test/setup.ts'],
        },
      },
    ],
  },
});
