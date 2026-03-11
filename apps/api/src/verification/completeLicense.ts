/**
 * Complete License Verification - One-License-to-Account Linking
 *
 * API handler for POST /api/verification/complete-license
 * Verifies a license key (Gumroad or Jinxxy), ties it to the subject,
 * and grants entitlements for all products the user owns from that provider.
 */

import { GumroadAdapter, JinxxyApiClient, detectLicenseFormat } from '@yucp/providers';
import { createLogger } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../lib/convex';
import { decrypt } from '../lib/encrypt';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';
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
          error: sanitizePublicErrorMessage(result.error, 'License verification failed'),
        };
      }

      const providerUserId =
        result.purchaseEmail ?? `gumroad:${productId}:${licenseKey.slice(0, 8)}`;
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
        api.licenseVerification.completeLicenseVerification,
        {
          apiSecret,
          tenantId,
          subjectId,
          provider: 'gumroad',
          providerUserId,
          providerMetadata: result.purchaseEmail ? { email: result.purchaseEmail } : undefined,
          productsToGrant,
        }
      );

      return {
        success: mutationResult.success,
        provider: 'gumroad',
        entitlementIds: mutationResult.entitlementIds,
        error: sanitizePublicErrorMessage(
          mutationResult.error,
          'The license could not be verified right now.'
        ),
      };
    }

    if (format === 'jinxxy') {
      const convex = getConvexClientFromUrl(config.convexUrl);
      // Try provider_connections first (connect flow), then tenant_provider_config (legacy)
      let tenantJinxxyKeyEncrypted: string | null = null;
      const conn = await convex.query(api.providerConnections.getConnectionForBackfill, {
        apiSecret: config.convexApiSecret,
        tenantId,
        provider: 'jinxxy',
      });
      if (conn?.jinxxyApiKeyEncrypted) {
        tenantJinxxyKeyEncrypted = conn.jinxxyApiKeyEncrypted;
      }
      if (!tenantJinxxyKeyEncrypted) {
        tenantJinxxyKeyEncrypted = await convex.query(
          api.tenantConfig.getJinxxyApiKeyForVerification,
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
          error: 'Jinxxy API key not configured. Add your Jinxxy API key in `/creator setup`.',
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
          error: sanitizePublicErrorMessage(verifyResult.error, 'License verification failed'),
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
        api.licenseVerification.completeLicenseVerification,
        {
          apiSecret: config.convexApiSecret,
          tenantId,
          subjectId,
          provider: 'jinxxy',
          providerUserId: customerId,
          productsToGrant,
        }
      );

      if (mutationResult.success) {
        return {
          success: true,
          provider: 'jinxxy',
          entitlementIds: mutationResult.entitlementIds,
        };
      }

      // Primary key failed - try collaborator connections
      const collabConnections = (await convex.query(
        api.collaboratorInvites.getCollabConnectionsForVerification,
        { apiSecret: config.convexApiSecret, ownerTenantId: tenantId }
      )) as Array<{ id: string; jinxxyApiKeyEncrypted?: string }>;

      for (const collab of collabConnections) {
        if (!collab.jinxxyApiKeyEncrypted) continue;
        try {
          const collabKey = await decrypt(
            collab.jinxxyApiKeyEncrypted,
            config.encryptionSecret ?? ''
          );
          const collabClient = new JinxxyApiClient({
            apiKey: collabKey,
            apiBaseUrl: process.env.JINXXY_API_BASE_URL,
          });
          const collabResult = await collabClient.verifyLicenseByKey(licenseKey.trim());
          if (collabResult.valid && collabResult.license) {
            const collabLicense = collabResult.license;
            if (!collabLicense.product_id) continue;
            const collabCustomerId = collabLicense.customer_id ?? collabLicense.id;
            const collabMutation = await convex.mutation(
              api.licenseVerification.completeLicenseVerification,
              {
                apiSecret: config.convexApiSecret,
                tenantId,
                subjectId,
                provider: 'jinxxy',
                providerUserId: collabCustomerId,
                productsToGrant: [
                  {
                    productId: collabLicense.product_id,
                    sourceReference: `jinxxy-collab:${collab.id}:license:${collabLicense.id}`,
                  },
                ],
              }
            );
            if (collabMutation.success) {
              return {
                success: true,
                provider: 'jinxxy',
                entitlementIds: collabMutation.entitlementIds,
              };
            }
          }
        } catch (collabErr) {
          logger.warn('Collab Jinxxy verification failed', {
            collabConnectionId: collab.id,
            error: collabErr instanceof Error ? collabErr.message : String(collabErr),
          });
        }
      }

      return {
        success: mutationResult.success,
        provider: 'jinxxy',
        entitlementIds: mutationResult.entitlementIds,
        error: sanitizePublicErrorMessage(
          mutationResult.error,
          'The license could not be verified right now.'
        ),
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
      error: sanitizePublicErrorMessage(
        err instanceof Error ? err.message : String(err),
        'The license could not be verified right now.'
      ),
    };
  }
}
