import { describe, expect, it } from 'bun:test';
import {
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
      description: 'Enter the Gumroad license key for this product.',
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
});
