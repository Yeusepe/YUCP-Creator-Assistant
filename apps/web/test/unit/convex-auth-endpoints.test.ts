import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function createTestAuth() {
  process.env.BETTER_AUTH_SECRET = 'test-secret-123456789012345678901234';
  process.env.CONVEX_SITE_URL = 'https://example.convex.site';
  process.env.CONVEX_URL = 'https://example.convex.cloud';
  process.env.FRONTEND_URL = 'http://localhost:3000';
  process.env.SITE_URL = 'http://localhost:3000';
  delete process.env.DISCORD_CLIENT_ID;
  delete process.env.DISCORD_CLIENT_SECRET;

  vi.resetModules();
  const { createAuth } = await import('../../../../convex/auth');
  return createAuth({} as never);
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('Convex Better Auth endpoints', () => {
  it('serves /api/auth/convex/token instead of returning 404', async () => {
    const auth = await createTestAuth();

    const health = await auth.handler(new Request('http://localhost:3000/api/auth/ok'));
    expect(health.status).toBe(200);

    const response = await auth.handler(new Request('http://localhost:3000/api/auth/convex/token'));

    expect(response.status).toBe(401);
  });
});
