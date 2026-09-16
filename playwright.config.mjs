import { defineConfig } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/e2e.spec.mjs',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL,
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && node src/backend/server.js',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      PORT: process.env.PORT || '4173',
      DATABASE_PATH: process.env.DATABASE_PATH || '/tmp/clippy-e2e.sqlite',
    },
  },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
});
