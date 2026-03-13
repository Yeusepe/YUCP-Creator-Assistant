/**
 * Complete VRChat Verification - Ownership-based Avatar License Check
 *
 * API handler for POST /api/verification/complete-vrchat
 * Matches already-verified VRChat ownership against the catalog and grants
 * entitlements for all matching products.
 */

import { createLogger } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../lib/convex';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';
import type { VerificationConfig } from './sessionManager';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const GENERIC_ERROR = 'Verification failed. Please try again.';

export interface CompleteVrchatInput {
  authUserId: string;
  subjectId: string;
  productId?: string;
  vrchatUserId: string;
  displayName: string;
  ownedAvatarIds: string[];
}

export interface CompleteVrchatResult {
  success: boolean;
  provider?: 'vrchat';
  entitlementIds?: string[];
  error?: string;
}

/**
 * Handle complete-vrchat verification
 */
export async function handleCompleteVrchat(
  config: VerificationConfig,
  input: CompleteVrchatInput
): Promise<CompleteVrchatResult> {
  const { authUserId, subjectId, vrchatUserId, displayName, ownedAvatarIds } = input;

  if (!authUserId) return { success: false, error: 'Missing auth user ID' };
  if (!subjectId) return { success: false, error: 'Missing subject ID' };
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
    const matches = await convex.query(api.role_rules.getVrchatCatalogProductsMatchingAvatars, {
      apiSecret: config.convexApiSecret,
      authUserId,
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
        authUserId,
        subjectId,
        provider: 'vrchat',
        providerUserId: vrchatUserId,
        providerUsername: displayName,
        productsToGrant,
      }
    );

    if (productsToGrant.length === 0) {
      logger.info('[completeVrchat] Linked VRChat account with no matching catalog products', {
        authUserId,
        subjectId,
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
        authUserId,
        subjectId,
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
      authUserId,
      subjectId,
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
