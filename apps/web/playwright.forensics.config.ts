import { defineConfig, devices } from 'playwright/test';

const defaultBaseUrl = 'http://localhost:3100';
const baseURL = process.env.TEST_BASE_URL ?? defaultBaseUrl;
const baseUrl = new URL(baseURL);
const webServerPort = Number(baseUrl.port || (baseUrl.protocol === 'https:' ? '443' : '80'));

const harnessServer = {
  command: 'bun test\\e2e\\forensicsHarness.ts',
  cwd: import.meta.dirname,
  env: {
    ...process.env,
  },
  port: 3211,
  reuseExistingServer: false,
};

export default defineConfig({
  testDir: './test/e2e',
  testMatch: 'forensics.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.TEST_BASE_URL
    ? [harnessServer]
    : [
        harnessServer,
        {
          command: `bun run dev -- --port ${webServerPort} --strictPort`,
          cwd: import.meta.dirname,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            FRONTEND_URL: baseURL,
            SITE_URL: baseURL,
            API_BASE_URL: 'http://127.0.0.1:3211',
            CONVEX_SITE_URL: 'http://127.0.0.1:3210',
            INTERNAL_RPC_SHARED_SECRET: 'test-internal-rpc-secret-32-chars!!',
          },
          port: webServerPort,
          reuseExistingServer: false,
        },
      ],
});
