import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reactStartSpy = vi.fn(() => ({
  handler: vi.fn(),
  getToken: vi.fn(),
  fetchAuthQuery: vi.fn(),
  fetchAuthMutation: vi.fn(),
  fetchAuthAction: vi.fn(),
}));

vi.mock('@convex-dev/better-auth/react-start', () => ({
  convexBetterAuthReactStart: reactStartSpy,
}));

describe('auth-server environment resolution', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('derives CONVEX_SITE_URL from CONVEX_URL when the site URL is unset', async () => {
    vi.stubEnv('CONVEX_URL', 'https://rare-squid-409.convex.cloud');
    vi.stubEnv('CONVEX_SITE_URL', '');

    await import('@/lib/auth-server');

    expect(reactStartSpy).toHaveBeenCalledWith({
      convexUrl: 'https://rare-squid-409.convex.cloud',
      convexSiteUrl: 'https://rare-squid-409.convex.site',
    });
  });
});
