import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/client';
import {
  getPurchaseIntentLoadErrorState,
  getVisiblePurchaseVerificationError,
  shouldAutoCheckExistingEntitlement,
} from '../../src/routes/verify/-purchaseUiState';

describe('purchase verification ui state', () => {
  it('does not auto-check existing entitlement when OAuth or manual methods are available', () => {
    expect(
      shouldAutoCheckExistingEntitlement([
        { kind: 'existing_entitlement' },
        { kind: 'buyer_provider_link' },
      ])
    ).toBe(false);

    expect(
      shouldAutoCheckExistingEntitlement([
        { kind: 'existing_entitlement' },
        { kind: 'manual_license' },
      ])
    ).toBe(false);
  });

  it('auto-checks existing entitlement when it is the only verification path', () => {
    expect(shouldAutoCheckExistingEntitlement([{ kind: 'existing_entitlement' }])).toBe(true);
  });

  it('hides entitlement-missing banners when the user still has other verification methods', () => {
    expect(
      getVisiblePurchaseVerificationError({
        errorCode: 'entitlement_missing',
        errorMessage: 'No active entitlement was found for this verification method.',
        requirements: [
          {
            methodKey: 'existing-entitlement',
            providerKey: 'yucp',
            providerLabel: 'YUCP',
            kind: 'existing_entitlement',
            title: 'Check connected YUCP access',
            description: null,
            creatorAuthUserId: 'creator-1',
            productId: 'product-1',
            providerProductRef: null,
            capability: {
              methodKind: 'existing_entitlement',
              completion: 'immediate',
              actionLabel: 'Check access',
            },
          },
          {
            methodKey: 'gumroad-oauth',
            providerKey: 'gumroad',
            providerLabel: 'Gumroad',
            kind: 'buyer_provider_link',
            title: 'Gumroad account',
            description: null,
            creatorAuthUserId: 'creator-1',
            productId: 'product-1',
            providerProductRef: 'my-product',
            capability: {
              methodKind: 'buyer_provider_link',
              completion: 'immediate',
              actionLabel: 'Sign in with Gumroad',
            },
          },
        ],
      })
    ).toBeNull();
  });

  it('keeps purchase-specific errors visible', () => {
    expect(
      getVisiblePurchaseVerificationError({
        errorCode: 'purchase_not_found',
        errorMessage: 'No purchase was found for this account.',
        requirements: [
          {
            methodKey: 'gumroad-oauth',
            providerKey: 'gumroad',
            providerLabel: 'Gumroad',
            kind: 'buyer_provider_link',
            title: 'Gumroad account',
            description: null,
            creatorAuthUserId: 'creator-1',
            productId: 'product-1',
            providerProductRef: 'my-product',
            capability: {
              methodKind: 'buyer_provider_link',
              completion: 'immediate',
              actionLabel: 'Sign in with Gumroad',
            },
          },
        ],
      })
    ).toBe('No purchase was found for this account.');
  });

  it('maps wrong-user API errors to a sign-out recovery state', () => {
    expect(
      getPurchaseIntentLoadErrorState(
        new ApiError(409, {
          code: 'verification_intent_wrong_user',
          error:
            'This verification link was created for a different YUCP account. Sign out here, then continue with the same YUCP account you used in Unity.',
        })
      )
    ).toEqual({
      title: 'Wrong YUCP account',
      message:
        'This verification link was created for a different YUCP account. Sign out here, then continue with the same YUCP account you used in Unity.',
      allowSignOut: true,
    });
  });

  it('maps missing intents to the standard restart message', () => {
    expect(
      getPurchaseIntentLoadErrorState(
        new ApiError(404, {
          code: 'verification_intent_missing',
          error: 'Verification intent not found',
        })
      )
    ).toEqual({
      title: 'Verification not found',
      message:
        'This verification link is invalid or has already expired. Return to Unity and restart the verification flow.',
      allowSignOut: false,
    });
  });
});
