import { describe, expect, it } from 'bun:test';
import { getConnectedAccountProviderDisplay, listUserLinkProviderDisplays } from './display';

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
});
