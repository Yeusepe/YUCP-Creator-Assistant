import { describe, expect, it } from 'bun:test';
import type { ProviderPlatformPort } from '../ports/providerPlatform';
import { ProviderPlatformService } from './providerPlatformService';

function createPort(): ProviderPlatformPort {
  const runtimeSurfaces = [
    {
      providerKey: 'gumroad',
      label: 'Gumroad',
      icon: 'gumroad.png',
      color: '#ff90e8',
      description: 'Creator storefront',
      dashboardConnectPath: '/setup/gumroad',
      dashboardConnectParamStyle: 'camelCase' as const,
      dashboardIconBg: '#fff0fb',
      dashboardQuickStartBg: '#ffffff',
      dashboardQuickStartBorder: '#f3b9e4',
      dashboardServerTileHint: 'Connect your Gumroad store',
    },
    {
      providerKey: 'vrchat',
      label: 'VRChat',
      icon: 'vrchat.png',
      color: '#1d4ed8',
      description: 'Virtual world ownership',
      dashboardConnectPath: '/setup/vrchat?mode=connect',
      dashboardConnectParamStyle: 'snakeCase' as const,
      dashboardIconBg: '#dbeafe',
      dashboardQuickStartBg: '#eff6ff',
      dashboardQuickStartBorder: '#93c5fd',
      dashboardServerTileHint: 'Connect your VRChat account',
    },
    {
      providerKey: 'jinxxy',
      label: 'Jinxxy',
      icon: 'jinxxy.png',
      color: '#111827',
      description: 'License verification',
    },
  ] as const;

  return {
    listRuntimeConnectSurfaces: () => runtimeSurfaces,
    getRuntimeConnectSurface: (providerKey) =>
      runtimeSurfaces.find((runtimeSurface) => runtimeSurface.providerKey === providerKey),
    isVerificationAvailable: (providerKey) =>
      providerKey === 'gumroad' || providerKey === 'discord' || providerKey === 'vrchat',
    getVerificationOnlyDisplay: (providerKey) =>
      providerKey === 'discord'
        ? { icon: 'Discord.png', color: '#5865F2', description: null }
        : undefined,
  };
}

describe('ProviderPlatformService', () => {
  it('lists dashboard providers from runtime connect surfaces only', () => {
    const service = new ProviderPlatformService(createPort());

    expect(service.listDashboardProviderDisplays()).toEqual([
      {
        key: 'gumroad',
        label: 'Gumroad',
        icon: 'gumroad.png',
        iconBg: '#fff0fb',
        quickStartBg: '#ffffff',
        quickStartBorder: '#f3b9e4',
        serverTileHint: 'Connect your Gumroad store',
        connectPath: '/setup/gumroad',
        connectParamStyle: 'camelCase',
      },
      {
        key: 'vrchat',
        label: 'VRChat',
        icon: 'vrchat.png',
        iconBg: '#dbeafe',
        quickStartBg: '#eff6ff',
        quickStartBorder: '#93c5fd',
        serverTileHint: 'Connect your VRChat account',
        connectPath: '/setup/vrchat?mode=connect',
        connectParamStyle: 'snakeCase',
      },
    ]);
  });

  it('includes verification-only OAuth providers in user link displays', () => {
    const service = new ProviderPlatformService(createPort());
    const providerIds = service.listUserLinkProviderDisplays().map((provider) => provider.id);

    expect(providerIds).toContain('gumroad');
    expect(providerIds).toContain('discord');
    expect(providerIds).not.toContain('jinxxy');
    expect(providerIds).not.toContain('vrchat');

    expect(service.getConnectedAccountProviderDisplay('discord')).toEqual({
      id: 'discord',
      label: 'Discord',
      icon: null,
      color: null,
      description: null,
    });
  });
});
