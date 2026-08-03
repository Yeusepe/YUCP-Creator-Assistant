/** Provider Platform webhook route smoke tests. */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startTestServer, type TestServerHandle } from './helpers/testServer';

let server: TestServerHandle;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(() => {
  server.stop();
});

// ---------------------------------------------------------------------------
// Webhook route, covered in detail in webhooks.test.ts; minimal smoke here
// ---------------------------------------------------------------------------

describe('LemonSqueezy webhook route (smoke only, full coverage in webhooks.test.ts)', () => {
  it('POST /v1/webhooks/lemonsqueezy/:id → not 200 (no Convex backend)', async () => {
    const res = await server.fetch('/v1/webhooks/lemonsqueezy/test-conn-id', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': 'aaaa'.repeat(16),
      },
      body: JSON.stringify({ meta: { event_name: 'order_created' }, data: { id: '1' } }),
    });
    expect(res.status).not.toBe(200);
  });

  it('GET /v1/webhooks/lemonsqueezy/:id → 404 (GET not handled by providerPlatform)', async () => {
    const res = await server.fetch('/v1/webhooks/lemonsqueezy/test-conn-id', {
      method: 'GET',
    });
    expect(res.status).toBe(404);
  });
});
