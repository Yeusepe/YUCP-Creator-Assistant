import path from 'node:path';
import { defineConfig } from 'vitest/config';
import tsConfigPaths from 'vite-tsconfig-paths';

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
  },
});
