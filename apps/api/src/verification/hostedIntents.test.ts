import { describe, expect, it } from 'bun:test';
import {
  buildLinkedEntitlementRequirements,
  decorateHostedVerificationRequirement,
  normalizeHostedVerificationRequirements,
} from './hostedIntents';

describe('hostedIntents', () => {
  it('fills provider-owned capability defaults for manual license requirements', () => {
    const [requirement] = normalizeHostedVerificationRequirements([
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
      description: 'Enter the Gumroad license key you received for this product.',
      providerProductRef: 'abc123',
    });
  });

  it('decorates hosted requirements with provider labels and capability metadata', () => {
    const requirement = decorateHostedVerificationRequirement({
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
    const [requirement] = normalizeHostedVerificationRequirements([
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
    const requirement = decorateHostedVerificationRequirement({
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

  it('accepts itch.io buyer-linked account requirements for hosted verification', () => {
    const [requirement] = normalizeHostedVerificationRequirements([
      {
        methodKey: 'itchio-link',
        providerKey: 'itchio',
        kind: 'buyer_provider_link',
        creatorAuthUserId: 'creator_123',
        productId: 'product_123',
        providerProductRef: '42',
      },
    ]);

    expect(requirement).toMatchObject({
      methodKey: 'itchio-link',
      providerKey: 'itchio',
      kind: 'buyer_provider_link',
      creatorAuthUserId: 'creator_123',
      productId: 'product_123',
      providerProductRef: '42',
    });
  });

  it('rejects buyer-linked account requirements for providers without a hosted link flow', () => {
    expect(() =>
      normalizeHostedVerificationRequirements([
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
      normalizeHostedVerificationRequirements([
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
      normalizeHostedVerificationRequirements([
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
      normalizeHostedVerificationRequirements([
        {
          methodKey: 'payhip-license',
          providerKey: 'payhip',
          kind: 'manual_license',
          providerProductRef: 'RGsF',
        },
      ])
    ).toThrow("Provider 'payhip' does not support hosted manual license verification");
  });

  it('derives linked entitlement requirements from provider-specific product mappings', async () => {
    const derived = await buildLinkedEntitlementRequirements(
      {
        _id: 'intent_123',
        authUserId: 'buyer_123',
        packageId: 'pkg_123',
        returnUrl: 'http://127.0.0.1/callback',
        requirements: [
          {
            methodKey: 'existing-entitlement',
            providerKey: 'yucp',
            kind: 'existing_entitlement',
            title: 'Connected YUCP access',
            creatorAuthUserId: 'creator_123',
            productId: 'product_123',
          },
          {
            methodKey: 'jinxxy-license',
            providerKey: 'jinxxy',
            kind: 'manual_license',
            title: 'Jinxxy license',
            providerProductRef: 'prod_jinxxy',
          },
          {
            methodKey: 'gumroad-oauth',
            providerKey: 'gumroad',
            kind: 'buyer_provider_link',
            title: 'Gumroad account',
            creatorAuthUserId: 'creator_123',
            productId: 'product_123',
            providerProductRef: 'prod_gumroad',
          },
        ],
        status: 'pending',
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      ['jinxxy', 'gumroad', 'payhip'],
      async (requirement) =>
        requirement.providerKey === 'jinxxy' && requirement.providerProductRef === 'prod_jinxxy'
          ? {
              creatorAuthUserId: 'creator_123',
              productId: 'product_jinxxy_123',
            }
          : null
    );

    expect(derived).toEqual([
      {
        methodKey: 'jinxxy-existing-entitlement',
        providerKey: 'jinxxy',
        kind: 'existing_entitlement',
        title: 'Jinxxy access',
        description: 'Check whether your linked Jinxxy access already grants this package.',
        creatorAuthUserId: 'creator_123',
        productId: 'product_jinxxy_123',
        providerProductRef: undefined,
      },
    ]);
  });
});
