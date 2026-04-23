/**
 * Complete VRChat Verification - Ownership-based Avatar License Check
 *
 * API handler for POST /api/verification/complete-vrchat
 * Matches already-verified VRChat ownership against the catalog and grants
 * entitlements for all matching products.
 */

import { api } from '../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../lib/convex';
import { logger } from '../lib/logger';
import { ensureSubjectAuthUserId, SUBJECT_AUTH_USER_REQUIRED_ERROR } from '../lib/subjectIdentity';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';
import type { VerificationConfig } from './verificationConfig';

const GENERIC_ERROR = 'Verification failed. Please try again.';

interface CompleteVrchatBaseInput {
  productId?: string;
  vrchatUserId: string;
  displayName: string;
  ownedAvatarIds: string[];
}

interface CompleteVrchatLegacyIdentityInput {
  authUserId: string;
  subjectId: string;
  creatorAuthUserId?: never;
  buyerAuthUserId?: never;
  buyerSubjectId?: never;
}

interface CompleteVrchatExplicitIdentityInput {
  creatorAuthUserId: string;
  buyerAuthUserId: string;
  buyerSubjectId: string;
  authUserId?: never;
  subjectId?: never;
}

export type CompleteVrchatInput = CompleteVrchatBaseInput &
  (CompleteVrchatLegacyIdentityInput | CompleteVrchatExplicitIdentityInput);

interface ResolvedCompleteVrchatInput extends CompleteVrchatBaseInput {
  creatorAuthUserId: string;
  buyerAuthUserId: string;
  buyerSubjectId: string;
  identityMode: 'legacy' | 'explicit';
}

export interface CompleteVrchatResult {
  success: boolean;
  provider?: 'vrchat';
  entitlementIds?: string[];
  error?: string;
}

function resolveCompleteVrchatInput(
  input: CompleteVrchatInput
): { ok: true; value: ResolvedCompleteVrchatInput } | { ok: false; error: string } {
  const hasLegacyIdentity = 'authUserId' in input || 'subjectId' in input;
  const hasExplicitIdentity =
    'creatorAuthUserId' in input || 'buyerAuthUserId' in input || 'buyerSubjectId' in input;

  if (hasLegacyIdentity && hasExplicitIdentity) {
    return {
      ok: false,
      error:
        'Provide either authUserId/subjectId or creatorAuthUserId/buyerAuthUserId/buyerSubjectId',
    };
  }

  if (hasExplicitIdentity) {
    const { creatorAuthUserId, buyerAuthUserId, buyerSubjectId } =
      input as CompleteVrchatExplicitIdentityInput;
    if (!creatorAuthUserId) return { ok: false, error: 'Missing creator auth user ID' };
    if (!buyerAuthUserId) return { ok: false, error: 'Missing buyer auth user ID' };
    if (!buyerSubjectId) return { ok: false, error: 'Missing buyer subject ID' };

    return {
      ok: true,
      value: {
        productId: input.productId,
        vrchatUserId: input.vrchatUserId,
        displayName: input.displayName,
        ownedAvatarIds: input.ownedAvatarIds,
        creatorAuthUserId,
        buyerAuthUserId,
        buyerSubjectId,
        identityMode: 'explicit',
      },
    };
  }

  const { authUserId, subjectId } = input as CompleteVrchatLegacyIdentityInput;
  if (!authUserId) return { ok: false, error: 'Missing auth user ID' };
  if (!subjectId) return { ok: false, error: 'Missing subject ID' };

  return {
    ok: true,
    value: {
      productId: input.productId,
      vrchatUserId: input.vrchatUserId,
      displayName: input.displayName,
      ownedAvatarIds: input.ownedAvatarIds,
      creatorAuthUserId: authUserId,
      buyerAuthUserId: authUserId,
      buyerSubjectId: subjectId,
      identityMode: 'legacy',
    },
  };
}

/**
 * Handle complete-vrchat verification
 */
export async function handleCompleteVrchat(
  config: VerificationConfig,
  input: CompleteVrchatInput
): Promise<CompleteVrchatResult> {
  const resolvedInput = resolveCompleteVrchatInput(input);
  if (!resolvedInput.ok) {
    return { success: false, error: resolvedInput.error };
  }

  const { vrchatUserId, displayName, ownedAvatarIds } = resolvedInput.value;

  if (!vrchatUserId) return { success: false, error: 'Missing VRChat user ID' };
  if (!displayName) return { success: false, error: 'Missing VRChat display name' };
  if (!Array.isArray(ownedAvatarIds)) {
    return { success: false, error: 'Missing owned avatar IDs' };
  }

  if (!config.convexUrl || !config.convexApiSecret) {
    return { success: false, error: 'Verification not configured' };
  }

  try {
    const convex = getConvexClientFromUrl(config.convexUrl);
    let verificationInput = resolvedInput.value;
    if (resolvedInput.value.identityMode === 'legacy') {
      const buyerAuthUserId = await ensureSubjectAuthUserId(
        convex,
        resolvedInput.value.buyerSubjectId
      );
      if (!buyerAuthUserId) {
        return { success: false, error: SUBJECT_AUTH_USER_REQUIRED_ERROR };
      }
      verificationInput = {
        ...resolvedInput.value,
        buyerAuthUserId,
      };
    }
    const matches = await convex.query(api.role_rules.getVrchatCatalogProductsMatchingAvatars, {
      apiSecret: config.convexApiSecret,
      authUserId: verificationInput.creatorAuthUserId,
      ownedAvatarIds,
    });

    const productsToGrant = (
      matches as Array<{
        productId: string;
        catalogProductId: string;
        providerProductRef: string;
      }>
    ).map((m) => ({
      productId: m.productId,
      sourceReference: `vrchat:avatar:${m.providerProductRef}`,
      catalogProductId: m.catalogProductId,
    }));

    const mutationResult = await convex.mutation(
      api.licenseVerification.completeLicenseVerification,
      {
        apiSecret: config.convexApiSecret,
        creatorAuthUserId: verificationInput.creatorAuthUserId,
        buyerAuthUserId: verificationInput.buyerAuthUserId,
        subjectId: verificationInput.buyerSubjectId,
        provider: 'vrchat',
        providerUserId: vrchatUserId,
        providerUsername: displayName,
        productsToGrant,
      }
    );

    if (productsToGrant.length === 0) {
      logger.info('[completeVrchat] Linked VRChat account with no matching catalog products', {
        creatorAuthUserId: verificationInput.creatorAuthUserId,
        buyerAuthUserId: verificationInput.buyerAuthUserId,
        buyerSubjectId: verificationInput.buyerSubjectId,
        provider: 'vrchat',
        ownedCount: ownedAvatarIds.length,
      });
      return {
        success: mutationResult.success,
        provider: 'vrchat',
        entitlementIds: mutationResult.entitlementIds,
        error: 'No products from this server match your VRChat avatars.',
      };
    }

    if (mutationResult.success) {
      logger.info('[completeVrchat] Success', {
        creatorAuthUserId: verificationInput.creatorAuthUserId,
        buyerAuthUserId: verificationInput.buyerAuthUserId,
        buyerSubjectId: verificationInput.buyerSubjectId,
        provider: 'vrchat',
        productCount: productsToGrant.length,
      });
    }

    return {
      success: mutationResult.success,
      provider: 'vrchat',
      entitlementIds: mutationResult.entitlementIds,
      error: sanitizePublicErrorMessage(mutationResult.error, GENERIC_ERROR),
    };
  } catch (err) {
    logger.error('Complete VRChat verification failed', {
      error: err instanceof Error ? err.message : String(err),
      creatorAuthUserId: resolvedInput.value.creatorAuthUserId,
      buyerAuthUserId: resolvedInput.value.buyerAuthUserId,
      buyerSubjectId: resolvedInput.value.buyerSubjectId,
      provider: 'vrchat',
    });
    return {
      success: false,
      error: sanitizePublicErrorMessage(
        err instanceof Error ? err.message : String(err),
        GENERIC_ERROR
      ),
    };
  }
}
