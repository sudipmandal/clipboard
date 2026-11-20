import { defineConfig } from '@playwright/test';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const port = process.env.CLIPPY_E2E_PORT || '4173';
const runId = createHash('sha256').update(`${process.cwd()}:${port}`).digest('hex').slice(0, 12);
const runRoot = path.join(tmpdir(), `clippy-e2e-${runId}`);
const baseURL = `http://127.0.0.1:${port}`;
process.env.CLIPPY_E2E_ROOT = runRoot;

export default defineConfig({
  workers: 1,
  testDir: './tests',
  testMatch: ['**/e2e.spec.mjs', '**/hotfix-regressions.spec.mjs'],
  timeout: 30_000,
  retries: 0,
  globalTeardown: './tests/playwright-global-teardown.mjs',
  use: {
    baseURL,
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/prepare-e2e.mjs && npm run build && node src/backend/server.js',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: port,
      MAX_FILE_BYTES: '65536', // Also bounds shared upload staging in the browser suite.
      MAX_FILES_BYTES: '8388608',
      DATABASE_PATH: path.join(runRoot, 'database.sqlite'),
      FILES_PATH: path.join(runRoot, 'files'),
      LEGACY_DATABASE_PATH: path.join(runRoot, 'no-legacy.sqlite'),
      DIST_PATH: path.resolve('dist'),
    },
  },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
});
