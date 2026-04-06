import { describe, expect, it } from 'bun:test';
import type { HostedVerificationProviderPort } from '../ports/hostedVerification';
import { HostedVerificationService } from './hostedVerificationService';

function createProviders(): HostedVerificationProviderPort {
  return {
    getProvider(providerKey) {
      switch (providerKey) {
        case 'gumroad':
          return {
            label: 'Gumroad',
            buyerVerificationMethods: ['license_key', 'account_link', 'oauth'],
            supportsHostedBuyerAccountLink: true,
            describeManualLicenseCapability: () => ({
              methodKind: 'manual_license',
              completion: 'immediate',
              actionLabel: 'Verify license',
              defaultTitle: 'Gumroad license',
              defaultDescription: 'Enter the Gumroad license key for this product.',
              input: {
                kind: 'license_key',
                label: 'License Key',
                placeholder: 'XXXXXXXX',
                masked: false,
                submitLabel: 'Verify',
              },
            }),
          };
        case 'jinxxy':
          return {
            label: 'Jinxxy',
            buyerVerificationMethods: ['license_key', 'account_link'],
            supportsHostedBuyerAccountLink: false,
            describeManualLicenseCapability: () => ({
              methodKind: 'manual_license',
              completion: 'immediate',
              actionLabel: 'Verify license',
              defaultTitle: 'Jinxxy license',
              defaultDescription: 'Enter the Jinxxy license key for this product.',
              input: {
                kind: 'license_key',
                label: 'License Key',
                masked: false,
                submitLabel: 'Verify',
              },
            }),
          };
        case 'lemonsqueezy':
          return {
            label: 'Lemon Squeezy',
            buyerVerificationMethods: ['account_link'],
            supportsHostedBuyerAccountLink: false,
            describeManualLicenseCapability: () => null,
          };
        case 'vrchat':
          return {
            label: 'VRChat',
            buyerVerificationMethods: ['account_link'],
            supportsHostedBuyerAccountLink: false,
            describeManualLicenseCapability: () => null,
          };
        case 'payhip':
          return {
            label: 'Payhip',
            buyerVerificationMethods: [],
            supportsHostedBuyerAccountLink: false,
            describeManualLicenseCapability: () => null,
          };
        default:
          return undefined;
      }
    },
  };
}

describe('HostedVerificationService', () => {
  const service = new HostedVerificationService({ providers: createProviders() });

  it('fills provider-owned capability defaults for manual license requirements', () => {
    const [requirement] = service.normalizeRequirements([
      {
        methodKey: 'gumroad-license',
        providerKey: 'gumroad',
        kind: 'manual_license',
        providerProductRef: 'abc123',
      },
    ]);

    expect(requirement).toMatchObject({
      methodKey: 'gumroad-license',
      providerKey: 'gumroad',
      kind: 'manual_license',
      title: 'Gumroad license',
      description: 'Enter the Gumroad license key for this product.',
      providerProductRef: 'abc123',
    });
  });

  it('decorates hosted requirements with provider labels and capability metadata', () => {
    const requirement = service.decorateRequirement({
      methodKey: 'jinxxy-entitlement',
      providerKey: 'jinxxy',
      kind: 'existing_entitlement',
      title: 'Existing Jinxxy access',
      description: 'Check existing entitlement state',
      creatorAuthUserId: 'creator_123',
      productId: 'product_123',
    });

    expect(requirement.providerLabel).toBe('Jinxxy');
    expect(requirement.capability).toEqual({
      methodKind: 'existing_entitlement',
      completion: 'immediate',
      actionLabel: 'Check access',
      input: undefined,
    });
  });

  it('accepts YUCP entitlement checks without requiring an external provider descriptor', () => {
    const [requirement] = service.normalizeRequirements([
      {
        methodKey: 'existing-entitlement',
        providerKey: 'yucp',
        kind: 'existing_entitlement',
        creatorAuthUserId: 'creator_123',
        productId: 'product_123',
      },
    ]);

    expect(requirement).toMatchObject({
      methodKey: 'existing-entitlement',
      providerKey: 'yucp',
      kind: 'existing_entitlement',
      title: 'Connected YUCP access',
      description:
        'Check whether your signed-in YUCP buyer account already has access to this package.',
      creatorAuthUserId: 'creator_123',
      productId: 'product_123',
    });
  });

  it('describes buyer-linked account requirements without provider branching in the caller', () => {
    const requirement = service.decorateRequirement({
      methodKey: 'gumroad-link',
      providerKey: 'gumroad',
      kind: 'buyer_provider_link',
      title: 'Linked Gumroad account',
    });

    expect(requirement.providerLabel).toBe('Gumroad');
    expect(requirement.capability).toEqual({
      methodKind: 'buyer_provider_link',
      completion: 'immediate',
      actionLabel: 'Use linked account',
      input: undefined,
    });
  });

  it('rejects buyer-linked account requirements for providers without a hosted link flow', () => {
    expect(() =>
      service.normalizeRequirements([
        {
          methodKey: 'lemonsqueezy-link',
          providerKey: 'lemonsqueezy',
          kind: 'buyer_provider_link',
        },
      ])
    ).toThrow("Provider 'lemonsqueezy' does not support buyer account linking in the hosted flow");
  });

  it('rejects buyer-linked account requirements for manual setup providers without hosted verification', () => {
    expect(() =>
      service.normalizeRequirements([
        {
          methodKey: 'vrchat-link',
          providerKey: 'vrchat',
          kind: 'buyer_provider_link',
        },
      ])
    ).toThrow("Provider 'vrchat' does not support buyer account linking in the hosted flow");
  });

  it('rejects buyer-linked account requirements for providers without OAuth account linking', () => {
    expect(() =>
      service.normalizeRequirements([
        {
          methodKey: 'jinxxy-link',
          providerKey: 'jinxxy',
          kind: 'buyer_provider_link',
        },
      ])
    ).toThrow("Provider 'jinxxy' does not support buyer account linking in the hosted flow");
  });

  it('rejects hosted manual license methods for providers without buyer adapters', () => {
    expect(() =>
      service.normalizeRequirements([
        {
          methodKey: 'payhip-license',
          providerKey: 'payhip',
          kind: 'manual_license',
          providerProductRef: 'RGsF',
        },
      ])
    ).toThrow("Provider 'payhip' does not support hosted manual license verification");
  });
});
