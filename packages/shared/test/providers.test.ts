import { describe, expect, it } from 'bun:test';
import {
  ACTIVE_PROVIDER_KEYS,
  getProviderDescriptor,
  PROVIDER_REGISTRY,
  PROVIDER_REGISTRY_BY_KEY,
  providerLabel,
} from '../src/providers';

describe('shared provider registry', () => {
  it('includes lemonsqueezy as an active commerce provider with phase 1 capabilities', () => {
    const lemon = getProviderDescriptor('lemonsqueezy');
    expect(lemon).toBeDefined();
    expect(lemon?.status).toBe('active');
    expect(lemon?.category).toBe('commerce');
    expect(lemon?.creatorAuthModes).toContain('api_token');
    expect(lemon?.capabilities).toContain('managed_webhooks');
    expect(lemon?.capabilities).toContain('catalog_sync');
    expect(lemon?.capabilities).toContain('license_verification');
    expect(lemon?.supportsTestMode).toBe(true);
    expect(lemon?.setupRequirements).toContain('store_selection');
  });

  it('keeps planned commerce providers in the contract but not active', () => {
    for (const providerKey of ['patreon', 'fourthwall', 'itchio'] as const) {
      const provider = PROVIDER_REGISTRY_BY_KEY[providerKey];
      expect(provider).toBeDefined();
      expect(provider.status).toBe('planned');
      expect(ACTIVE_PROVIDER_KEYS).not.toContain(providerKey);
    }
  });

  it('preserves Gumroad and Jinxxy compatibility metadata', () => {
    const gumroad = PROVIDER_REGISTRY_BY_KEY.gumroad;
    const jinxxy = PROVIDER_REGISTRY_BY_KEY.jinxxy;

    expect(gumroad.compatibility?.legacyConnectRoutes).toContain('/api/connect/gumroad/begin');
    expect(gumroad.compatibility?.legacyWebhookRoutes).toContain('/webhooks/gumroad/:authUserId');
    expect(jinxxy.compatibility?.legacyConnectRoutes).toContain('/api/connect/jinxxy-store');
    expect(jinxxy.compatibility?.legacyWebhookRoutes).toContain('/webhooks/jinxxy/:authUserId');
  });

  it('exposes stable provider labels and unique keys', () => {
    const keys = PROVIDER_REGISTRY.map((provider) => provider.providerKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(providerLabel('lemonsqueezy')).toBe('Lemon Squeezy');
    expect(providerLabel('gumroad')).toBe('Gumroad');
    expect(providerLabel('missing-provider')).toBe('missing-provider');
  });
});
