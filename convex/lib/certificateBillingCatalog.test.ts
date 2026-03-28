import { describe, expect, it } from 'bun:test';
import {
  aggregateCertificateBillingBenefitEntitlements,
  normalizeCertificateBillingCatalogBenefit,
  normalizeCertificateBillingCatalogProduct,
  POLAR_CERTIFICATE_BILLING_DOMAIN,
} from './certificateBillingCatalog';

describe('certificateBillingCatalog', () => {
  it('normalizes Polar products, prices, and benefit ids into a catalog snapshot', () => {
    const product = normalizeCertificateBillingCatalogProduct({
      id: 'prod_certificate_pro',
      name: 'Certificate Pro',
      description: 'High-trust signing',
      recurringInterval: 'month',
      metadata: {
        yucp_domain: POLAR_CERTIFICATE_BILLING_DOMAIN,
        yucp_sort: 20,
        yucp_display_badge: 'Most Popular',
        yucp_slug: 'certificate-pro',
      },
      prices: [
        {
          id: 'price_monthly',
          amountType: 'fixed',
        },
        {
          id: 'price_metered_signatures',
          amountType: 'metered_unit',
          meterId: 'meter_signatures',
          meter: { id: 'meter_signatures', name: 'Signature Events' },
        },
      ],
      benefits: [
        {
          id: 'benefit_devices',
          description: 'Up to 5 signing devices',
          metadata: { device_cap: 5 },
        },
        {
          id: 'benefit_exports',
          description: 'Protected exports',
          metadata: { capability_key: 'protected_exports' },
        },
      ],
    });

    expect(product).toEqual({
      productId: 'prod_certificate_pro',
      slug: 'certificate-pro',
      displayName: 'Certificate Pro',
      description: 'High-trust signing',
      status: 'active',
      sortOrder: 20,
      displayBadge: 'Most Popular',
      recurringInterval: 'month',
      recurringPriceIds: ['price_monthly'],
      meteredPrices: [
        {
          priceId: 'price_metered_signatures',
          meterId: 'meter_signatures',
          meterName: 'Signature Events',
        },
      ],
      benefitIds: ['benefit_devices', 'benefit_exports'],
      highlights: ['Up to 5 signing devices', 'Protected exports'],
      metadata: {
        yucp_domain: POLAR_CERTIFICATE_BILLING_DOMAIN,
        yucp_sort: 20,
        yucp_display_badge: 'Most Popular',
        yucp_slug: 'certificate-pro',
      },
    });
  });

  it('derives capability and entitlement metadata from Polar benefits', () => {
    const benefits = [
      normalizeCertificateBillingCatalogBenefit({
        id: 'benefit_feature_flag',
        type: 'feature_flag',
        description: 'Protected exports',
        metadata: {
          capability_key: 'protected_exports',
        },
      }),
      normalizeCertificateBillingCatalogBenefit({
        id: 'benefit_limits',
        type: 'custom',
        description: 'Pro support',
        metadata: {
          device_cap: 5,
          sign_quota_per_period: 1000,
          audit_retention_days: 90,
          support_tier: 'premium',
          tier_rank: 2,
        },
      }),
    ];

    expect(benefits[0]).toMatchObject({
      benefitId: 'benefit_feature_flag',
      type: 'feature_flag',
      capabilityKey: 'protected_exports',
    });

    expect(aggregateCertificateBillingBenefitEntitlements(benefits)).toEqual({
      capabilityKeys: ['protected_exports'],
      featureFlags: {
        protected_exports: true,
      },
      deviceCap: 5,
      signQuotaPerPeriod: 1000,
      auditRetentionDays: 90,
      supportTier: 'premium',
      tierRank: 2,
    });
  });

  it('treats native Polar feature-flag metadata entries as granted features', () => {
    const benefit = normalizeCertificateBillingCatalogBenefit({
      id: 'benefit_forensics',
      type: 'feature_flag',
      description: 'Coupling traceability',
      metadata: {
        coupling_traceability: true,
        moderation_lookup: 'premium',
      },
    });

    expect(benefit).toMatchObject({
      benefitId: 'benefit_forensics',
      type: 'feature_flag',
      capabilityKeys: ['coupling_traceability', 'moderation_lookup'],
      featureFlags: {
        coupling_traceability: true,
        moderation_lookup: 'premium',
      },
    });

    expect(aggregateCertificateBillingBenefitEntitlements([benefit])).toEqual({
      capabilityKeys: ['coupling_traceability', 'moderation_lookup'],
      featureFlags: {
        coupling_traceability: true,
        moderation_lookup: 'premium',
      },
    });
  });
});
