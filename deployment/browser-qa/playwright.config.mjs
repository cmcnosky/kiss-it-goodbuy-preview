import { defineConfig } from '@playwright/test';
import path from 'node:path';

const buildRoot = path.resolve(process.env.KIGB_BROWSER_QA_ROOT || '../../.build/dist');

export default defineConfig({
  testDir: '.',
  testMatch: 'storefront.spec.mjs',
  timeout: 30000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: `node server.mjs ${JSON.stringify(buildRoot)}`,
    url: 'http://127.0.0.1:4173/index.html',
    reuseExistingServer: false,
    timeout: 15000
  }
});
