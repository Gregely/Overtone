import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const port = Number(process.env.E2E_PORT ?? 4810);

/**
 * Smoke test: drives the BUILT web app (apps/web/dist) served by a real
 * Overtone server with a generated library and fake MusicBrainz.
 * Run with `npm run test:e2e` from the repo root (builds first).
 */
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], colorScheme: 'dark' } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], colorScheme: 'light' } },
  ],
  webServer: {
    command: 'npx tsx apps/server/src/testing/e2e-server.ts',
    cwd: repoRoot,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { E2E_PORT: String(port), OVERTONE_WEB_DIR: `${repoRoot}apps/web/dist` },
  },
});
