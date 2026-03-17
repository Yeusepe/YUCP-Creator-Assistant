import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './test/playwright',
  testMatch: '**/*.spec.ts',
  use: {
    // Set via TEST_BASE_URL env var when running: TEST_BASE_URL=http://localhost:3001 npx playwright test ...
    baseURL: process.env.TEST_BASE_URL || 'http://localhost:3001',
    // Capture screenshots / traces only on failure to keep CI artifacts lean
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // No webServer block — tests consume TEST_BASE_URL env var.
  // To run locally: start the API server first (bun run start), then set TEST_BASE_URL.
});
