import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'edge-runtime',
    include: ['**/*.realtest.?(c|m)[jt]s?(x)'],
    env: {
      ENCRYPTION_SECRET: 'test-encryption-secret-32-bytes!!',
    },
  },
});
