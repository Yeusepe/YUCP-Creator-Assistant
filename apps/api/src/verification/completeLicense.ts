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
 * Fetch all licenses for a Jinxxy customer (handles pagination)
 */
async function getAllLicensesForCustomer(
  client: JinxxyApiClient,
  customerId: string
): Promise<Array<{ product_id: string; id: string; key: string }>> {
  const allLicenses: Array<{ product_id: string; id: string; key: string }> = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const { licenses, pagination } = await client.getLicenses({
      customer_id: customerId,
      status: 'active',
      page,
      per_page: 50,
    });

    for (const lic of licenses) {
      if (lic.status === 'active') {
        allLicenses.push({
          product_id: lic.product_id,
          id: lic.id,
          key: lic.key,
        });
      }
    }

    hasMore = pagination.has_next ?? false;
    page += 1;
  }

  return allLicenses;
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

      const result = await gumroadAdapter.verifyLicense(licenseKey.trim(), productId);
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
      const tenantJinxxyKey = await convex.query(
        'tenantConfig:getJinxxyApiKeyForVerification' as any,
        { apiSecret: config.convexApiSecret, tenantId }
      );
      const jinxxyApiKey = tenantJinxxyKey ?? process.env.JINXXY_API_KEY;
      if (!jinxxyApiKey) {
        return {
          success: false,
          error:
            'Jinxxy API key not configured. Add your Jinxxy API key in `/creator setup` or set JINXXY_API_KEY.',
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
      const customerId = license.customer_id;

      if (!customerId) {
        return {
          success: false,
          error: 'License has no customer ID - cannot fetch other products',
        };
      }

      const allLicenses = await getAllLicensesForCustomer(jinxxyClient, customerId);

      const productsToGrant = allLicenses.map((lic) => ({
        productId: lic.product_id,
        sourceReference: `jinxxy:license:${lic.id}`,
      }));

      if (productsToGrant.length === 0) {
        return {
          success: false,
          error: 'No active licenses found for customer',
        };
      }

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
