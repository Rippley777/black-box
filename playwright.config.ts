import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:47922',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:47922',
    reuseExistingServer: false,
    timeout: 45_000,
    env: {
      BLACKBOX_DB: join(tmpdir(), `black-box-e2e-${process.pid}.db`),
      BLACKBOX_PORT: '47921',
      BLACKBOX_DASHBOARD_PORT: '47922',
    },
  },
});
