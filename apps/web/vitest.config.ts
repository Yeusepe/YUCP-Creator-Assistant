import path from 'node:path';
import tsConfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tsConfigPaths()],
  resolve: {
    alias: [
      {
        find: '@',
        replacement: path.resolve(__dirname, './src'),
      },
      {
        find: /^cloudflare:workers$/,
        replacement: path.resolve(__dirname, './test/unit/cloudflareWorkers.mock.ts'),
      },
    ],
  },
  test: {
    environment: 'happy-dom',
    include: ['test/unit/**/*.test.{ts,tsx}'],
    setupFiles: ['test/unit/setup.ts'],
    testTimeout: 15_000,
  },
});
