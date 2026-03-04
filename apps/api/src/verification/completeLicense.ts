/**
 * Complete License Verification - One-License-to-Account Linking
 *
 * API handler for POST /api/verification/complete-license
 * Verifies a license key (Gumroad or Jinxxy), ties it to the subject,
 * and grants entitlements for all products the user owns from that provider.
 */

import { createLogger } from '@yucp/shared';
import { detectLicenseFormat, GumroadAdapter, JinxxyApiClient } from '@yucp/providers';
import { getConvexClientFromUrl } from '../lib/convex';
import { decrypt } from '../lib/encrypt';
import type { VerificationConfig } from './sessionManager';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export interface CompleteLicenseInput {
  /** License key to verify */
  licenseKey: string;
  /** Product ID - required for Gumroad (provider product ID for verify API) */
  productId?: string;
  /** Tenant ID */
  tenantId: string;
  /** Subject ID (from Discord session) */
  subjectId: string;
}

export interface CompleteLicenseResult {
  success: boolean;
  provider?: 'gumroad' | 'jinxxy';
  entitlementIds?: string[];
  error?: string;
}

/**
 * Handle complete-license verification
 */
export async function handleCompleteLicense(
  config: VerificationConfig,
  input: CompleteLicenseInput
): Promise<CompleteLicenseResult> {
  const { licenseKey, productId, tenantId, subjectId } = input;

  if (!licenseKey?.trim()) {
    return { success: false, error: 'Missing license key' };
  }
  if (!tenantId) {
    return { success: false, error: 'Missing tenant ID' };
  }
  if (!subjectId) {
    return { success: false, error: 'Missing subject ID' };
  }

  const format = detectLicenseFormat(licenseKey.trim());
  if (format === 'unknown') {
    return { success: false, error: 'Unknown license format' };
  }

  if (!config.convexUrl || !config.convexApiSecret) {
    return { success: false, error: 'Verification not configured' };
  }

  try {
    if (format === 'gumroad') {
      if (!productId) {
        return { success: false, error: 'Product ID is required for Gumroad verification' };
      }

      const gumroadAdapter = new GumroadAdapter({
        clientId: config.gumroadClientId ?? '',
        clientSecret: config.gumroadClientSecret ?? '',
        redirectUri: `${config.baseUrl}/api/verification/callback/gumroad`,
      });

      logger.info('[completeLicense] Calling Gumroad verifyLicense', {
        productId,
        licenseKeyPrefix: licenseKey.trim().slice(0, 8),
        licenseKeyLength: licenseKey.trim().length,
        tenantId,
      });

      const result = await gumroadAdapter.verifyLicense(licenseKey.trim(), productId);

      logger.info('[completeLicense] Gumroad verifyLicense result', {
        valid: result.valid,
        error: result.error,
        purchaseEmail: result.purchaseEmail,
        saleId: result.saleId,
        uses: result.uses,
        isTestPurchase: result.isTestPurchase,
      });

      if (!result.valid) {
        return {
          success: false,
          error: result.error ?? 'License verification failed',
        };
      }

      const providerUserId = result.purchaseEmail ?? `gumroad:${productId}:${licenseKey.slice(0, 8)}`;
      const sourceReference = result.saleId ?? `gumroad:${productId}:${licenseKey.trim()}`;

      const productsToGrant = [
        {
          productId,
          sourceReference,
        },
      ];

      const convex = getConvexClientFromUrl(config.convexUrl);
      const apiSecret = config.convexApiSecret;

      const mutationResult = await convex.mutation(
        'licenseVerification:completeLicenseVerification' as any,
        {
          apiSecret,
          tenantId,
          subjectId,
          provider: 'gumroad',
          providerUserId,
          providerMetadata: result.purchaseEmail
            ? { email: result.purchaseEmail }
            : undefined,
          productsToGrant,
        }
      );

      return {
        success: mutationResult.success,
        provider: 'gumroad',
        entitlementIds: mutationResult.entitlementIds,
        error: mutationResult.error,
      };
    }

    if (format === 'jinxxy') {
      const convex = getConvexClientFromUrl(config.convexUrl);
      // Try provider_connections first (connect flow), then tenant_provider_config (legacy)
      let tenantJinxxyKeyEncrypted: string | null = null;
      const conn = await convex.query('providerConnections:getConnectionForBackfill' as any, {
        apiSecret: config.convexApiSecret,
        tenantId,
        provider: 'jinxxy',
      });
      if (conn?.jinxxyApiKeyEncrypted) {
        tenantJinxxyKeyEncrypted = conn.jinxxyApiKeyEncrypted;
      }
      if (!tenantJinxxyKeyEncrypted) {
        tenantJinxxyKeyEncrypted = await convex.query(
          'tenantConfig:getJinxxyApiKeyForVerification' as any,
          { apiSecret: config.convexApiSecret, tenantId }
        );
      }
      let jinxxyApiKey: string | undefined;
      if (tenantJinxxyKeyEncrypted) {
        if (!config.encryptionSecret) {
          return {
            success: false,
            error: 'Jinxxy API key decryption not configured (BETTER_AUTH_SECRET required).',
          };
        }
        try {
          jinxxyApiKey = await decrypt(tenantJinxxyKeyEncrypted, config.encryptionSecret);
        } catch (err) {
          logger.error('Failed to decrypt tenant Jinxxy API key', { tenantId, err });
          return {
            success: false,
            error: 'Failed to decrypt stored Jinxxy API key. Re-add your key in `/creator setup`.',
          };
        }
      }
      if (!jinxxyApiKey) {
        return {
          success: false,
          error:
            'Jinxxy API key not configured. Add your Jinxxy API key in `/creator setup`.',
        };
      }

      const jinxxyClient = new JinxxyApiClient({
        apiKey: jinxxyApiKey,
        apiBaseUrl: process.env.JINXXY_API_BASE_URL,
      });

      const verifyResult = await jinxxyClient.verifyLicenseByKey(licenseKey.trim());
      if (!verifyResult.valid || !verifyResult.license) {
        return {
          success: false,
          error: verifyResult.error ?? 'License verification failed',
        };
      }

      const license = verifyResult.license;
      const customerId = license.customer_id ?? license.id; // fallback for providerUserId

      // Jinxxy API does not support listing licenses by customer_id (only key/short_key).
      // Use the verified license directly (matches jinx-master: one key = one license = one product).
      if (!license.product_id) {
        return {
          success: false,
          error: 'License has no product - cannot grant entitlement',
        };
      }

      const productsToGrant = [
        {
          productId: license.product_id,
          sourceReference: `jinxxy:license:${license.id}`,
        },
      ];

      const mutationResult = await convex.mutation(
        'licenseVerification:completeLicenseVerification' as any,
        {
          apiSecret: config.convexApiSecret,
          tenantId,
          subjectId,
          provider: 'jinxxy',
          providerUserId: customerId,
          productsToGrant,
        }
      );

      return {
        success: mutationResult.success,
        provider: 'jinxxy',
        entitlementIds: mutationResult.entitlementIds,
        error: mutationResult.error,
      };
    }

    return { success: false, error: 'Unsupported provider' };
  } catch (err) {
    logger.error('Complete license verification failed', {
      error: err instanceof Error ? err.message : String(err),
      format,
      tenantId,
    });
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    };
  }
}
