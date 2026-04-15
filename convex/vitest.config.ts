import path from 'node:path';
import { defineConfig } from 'vitest/config';

const sharedSrc = path.resolve(__dirname, '../packages/shared/src').replace(/\\/g, '/');
const providersSrc = path.resolve(__dirname, '../packages/providers/src').replace(/\\/g, '/');

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@yucp\/shared$/, replacement: `${sharedSrc}/index.ts` },
      { find: /^@yucp\/shared\/(.*)$/, replacement: `${sharedSrc}/$1.ts` },
      { find: /^@yucp\/providers$/, replacement: `${providersSrc}/index.ts` },
      { find: /^@yucp\/providers\/(.*)$/, replacement: `${providersSrc}/$1.ts` },
    ],
  },
  test: {
    environment: 'edge-runtime',
    include: ['**/*.realtest.?(c|m)[jt]s?(x)'],
    env: {
      ENCRYPTION_SECRET: 'test-encryption-secret-32-bytes!!',
      INTERNAL_SERVICE_AUTH_SECRET: 'test-internal-service-secret',
      YUCP_COUPLING_HMAC_KEY: 'test-coupling-hmac-key-32-bytes!!',
      YUCP_GRANT_SEAL_KEY: 'test-grant-seal-key-32-bytes!!!',
    },
  },
});
