import { afterEach, describe, expect, it } from 'bun:test';
import {
  buildAuthUserWorkspaceKey,
  extractWorkspaceKeyFromMetadata,
  getCertificateBillingConfig,
  parseCertificateBillingProductsJson,
  resolveWorkspaceKeys,
} from './certificateBillingConfig';

describe('certificateBillingConfig', () => {
  const originalPolarAccessToken = process.env.POLAR_ACCESS_TOKEN;
  const originalPolarWebhookSecret = process.env.POLAR_WEBHOOK_SECRET;
  const originalPolarProductsJson = process.env.POLAR_CERT_PRODUCTS_JSON;

  afterEach(() => {
    process.env.POLAR_ACCESS_TOKEN = originalPolarAccessToken;
    process.env.POLAR_WEBHOOK_SECRET = originalPolarWebhookSecret;
    process.env.POLAR_CERT_PRODUCTS_JSON = originalPolarProductsJson;
  });

  it('parses product configuration with defaults', () => {
    const plans = parseCertificateBillingProductsJson(
      JSON.stringify([
        {
          planKey: 'starter',
          productId: 'prod_starter',
          slug: 'starter',
          deviceCap: 2,
        },
      ])
    );

    expect(plans).toEqual([
      {
        planKey: 'starter',
        productId: 'prod_starter',
        slug: 'starter',
        priority: 0,
        deviceCap: 2,
        signQuotaPerPeriod: null,
        auditRetentionDays: 30,
        supportTier: 'standard',
        billingGraceDays: 3,
      },
    ]);
  });

  it('enables billing only when Polar credentials and products are configured', () => {
    process.env.POLAR_ACCESS_TOKEN = 'polar-token';
    process.env.POLAR_WEBHOOK_SECRET = 'webhook-secret';
    process.env.POLAR_CERT_PRODUCTS_JSON = JSON.stringify([
      {
        planKey: 'pro',
        productId: 'prod_pro',
        slug: 'pro',
        deviceCap: 5,
      },
    ]);

    const config = getCertificateBillingConfig();

    expect(config.enabled).toBe(true);
    expect(config.products).toHaveLength(1);
  });

  it('resolves workspace key metadata with creator-profile preference', () => {
    expect(resolveWorkspaceKeys('user_123', 'profile_456')).toEqual([
      'creator-profile:profile_456',
      buildAuthUserWorkspaceKey('user_123'),
    ]);
    expect(
      extractWorkspaceKeyFromMetadata(
        { workspace_key: 'creator-profile:profile_456' },
        buildAuthUserWorkspaceKey('user_123')
      )
    ).toBe('creator-profile:profile_456');
  });
});
