import { defineConfig, devices } from 'playwright/test';

const browserAuthBaseUrl =
  process.env.SITE_URL ?? process.env.FRONTEND_URL ?? 'http://localhost:3001';

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: process.env.TEST_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.TEST_BASE_URL
    ? undefined
    : {
        command: 'npx vite dev',
        env: {
          ...process.env,
          SITE_URL: browserAuthBaseUrl,
          FRONTEND_URL: process.env.FRONTEND_URL ?? browserAuthBaseUrl,
        },
        port: 3000,
        reuseExistingServer: !process.env.CI,
      },
});
