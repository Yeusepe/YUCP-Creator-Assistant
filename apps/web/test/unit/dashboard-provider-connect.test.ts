import { describe, expect, it } from 'vitest';
import { buildProviderConnectUrl, type DashboardProvider } from '@/lib/dashboard';

describe('buildProviderConnectUrl', () => {
  it('appends dashboard identifiers to direct setup routes', () => {
    const provider: DashboardProvider = {
      key: 'jinxxy',
      connectPath: '/setup/jinxxy',
      connectParamStyle: 'camelCase',
    };

    expect(
      buildProviderConnectUrl(provider, {
        authUserId: 'tenant_123',
        guildId: 'guild_456',
      })
    ).toBe('/setup/jinxxy?tenantId=tenant_123&guildId=guild_456');
  });

  it('preserves existing query params when building a setup connect URL', () => {
    const provider: DashboardProvider = {
      key: 'vrchat',
      connectPath: '/setup/vrchat?mode=connect',
      connectParamStyle: 'snakeCase',
    };

    expect(
      buildProviderConnectUrl(provider, {
        authUserId: 'tenant_123',
        guildId: 'guild_456',
      })
    ).toBe('/setup/vrchat?mode=connect&tenant_id=tenant_123&guild_id=guild_456');
  });
});
