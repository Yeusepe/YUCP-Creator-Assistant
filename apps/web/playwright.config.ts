import path from 'node:path';
import { defineConfig, devices } from 'playwright/test';

const defaultBaseUrl = 'http://localhost:3100';
const baseURL =
  process.env.TEST_BASE_URL ?? process.env.FRONTEND_URL ?? process.env.SITE_URL ?? defaultBaseUrl;
const baseUrl = new URL(baseURL);
const webServerPort = Number(baseUrl.port || (baseUrl.protocol === 'https:' ? '443' : '80'));
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL,
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
        command: `bun run dev:web:infisical -- --port ${webServerPort} --strictPort`,
        cwd: repoRoot,
        env: {
          ...process.env,
          FRONTEND_URL: baseURL,
          SITE_URL: baseURL,
        },
        port: webServerPort,
        reuseExistingServer: false,
      },
});
