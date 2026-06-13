import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getRequestUrlMock = vi.fn();
const originalEnv = process.env;

vi.mock('@tanstack/react-start/server', () => ({
  getRequestUrl: getRequestUrlMock,
}));

describe('getPublicRuntimeConfigForRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.YUCP_ENABLE_AUTOMATIC_SETUP;
    delete process.env.YUCP_ENABLE_PRIVATE_VPM;
    getRequestUrlMock.mockReturnValue(new URL('https://preview.creators.yucp.club/sign-in'));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses the current request origin over configured env origins', async () => {
    process.env.SITE_URL = 'https://verify.creators.yucp.club';
    process.env.FRONTEND_URL = 'https://verify.creators.yucp.club';
    process.env.BUILD_ID = 'build-preview';

    const { getPublicRuntimeConfigForRequest } = await import('@/lib/runtimeConfig.server');

    expect(getPublicRuntimeConfigForRequest()).toEqual(
      expect.objectContaining({
        automaticSetupEnabled: false,
        browserAuthBaseUrl: 'https://preview.creators.yucp.club',
        buildId: 'build-preview',
        privateVpmEnabled: false,
      })
    );
    expect(getRequestUrlMock).toHaveBeenCalledWith({
      xForwardedHost: true,
      xForwardedProto: true,
    });
  });
});
