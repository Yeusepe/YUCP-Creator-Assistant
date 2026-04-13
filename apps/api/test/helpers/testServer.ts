/**
 * Test server helper, wraps createServer() for bun:test.
 *
 * Usage:
 *   import { startTestServer } from './helpers/testServer';
 *
 *   let server: TestServerHandle;
 *   beforeAll(async () => { server = await startTestServer(); });
 *   afterAll(() => server.stop());
 *
 *   it('GET /health', async () => {
 *     const res = await server.fetch('/health');
 *     expect(res.status).toBe(200);
 *   });
 */

import { createServer, type TestServer, type TestServerConfig } from '../../src/createServer';

// Shared defaults, all values are safe for tests (no real external services needed)
const DEFAULTS: TestServerConfig = {
  port: 0, // OS assigns a free port
  convexUrl: 'http://localhost:3210', // unused for HTTP-level tests; real URL needed for Convex state tests
  convexApiSecret: 'test-api-secret-min-32-characters!!',
  convexSiteUrl: 'http://localhost:3210',
  encryptionSecret: 'test-encryption-secret-32-chars!!',
  couplingServiceBaseUrl: 'http://127.0.0.1:8788',
  couplingServiceSharedSecret: 'test-coupling-secret',
  discordClientId: 'test-discord-client-id',
  discordClientSecret: 'test-discord-client-secret',
};

export interface TestServerHandle extends TestServer {
  /** Convenience wrapper: fetch relative path from the test server */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export async function startTestServer(
  overrides: Partial<TestServerConfig> = {}
): Promise<TestServerHandle> {
  const cfg: TestServerConfig = { ...DEFAULTS, ...overrides };
  const server = await createServer(cfg);

  return {
    ...server,
    fetch(path: string, init?: RequestInit): Promise<Response> {
      return globalThis.fetch(`${server.url}${path}`, init);
    },
  };
}
