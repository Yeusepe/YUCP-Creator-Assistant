import { describe, expect, it } from 'bun:test';
import {
  getConnectedAccountProviderDisplay,
  listHostedVerificationProviderDisplays,
  listUserLinkProviderDisplays,
} from './display';

describe('provider display helpers', () => {
  it('preserves connected-account fallback display for verification-only providers', () => {
    expect(getConnectedAccountProviderDisplay('discord')).toEqual({
      id: 'discord',
      label: 'Discord',
      icon: null,
      color: null,
      description: null,
    });
  });

  it('includes verification-only OAuth providers in the user link provider list', () => {
    const providers = listUserLinkProviderDisplays();
    const providerIds = providers.map((provider) => provider.id);

    expect(providerIds).toContain('gumroad');
    expect(providerIds).toContain('discord');
    expect(providerIds).not.toContain('jinxxy');
    expect(providerIds).not.toContain('vrchat');

    expect(providers.find((provider) => provider.id === 'discord')).toEqual({
      id: 'discord',
      label: 'Discord',
      icon: 'Discord.png',
      color: '#5865F2',
      description: null,
    });
  });

  it('includes non-OAuth hosted verification providers in the hosted verification display list', () => {
    const providers = listHostedVerificationProviderDisplays();
    const providerIds = providers.map((provider) => provider.id);

    expect(providerIds).toContain('gumroad');
    expect(providerIds).toContain('jinxxy');
    expect(providerIds).toContain('lemonsqueezy');
    expect(providerIds).toContain('payhip');

    expect(providers.find((provider) => provider.id === 'jinxxy')).toMatchObject({
      id: 'jinxxy',
      label: 'Jinxxy™',
      icon: 'Jinxxy.png',
      color: '#9146FF',
    });
  });
});
