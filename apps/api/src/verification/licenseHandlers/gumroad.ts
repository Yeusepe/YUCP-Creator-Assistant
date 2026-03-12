import { GumroadAdapter } from '@yucp/providers';
import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import type { ConvexServerClient } from '../../lib/convex';
import { sanitizePublicErrorMessage } from '../../lib/userFacingErrors';
import type { CompleteLicenseInput, CompleteLicenseResult } from '../completeLicense';
import type { VerificationConfig } from '../sessionManager';
import type { LicenseVerificationHandler } from './index';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export const gumroadHandler: LicenseVerificationHandler = {
  async verify(
    input: CompleteLicenseInput,
    config: VerificationConfig,
    convex: ConvexServerClient
  ): Promise<CompleteLicenseResult> {
    const { licenseKey, productId, tenantId, subjectId } = input;

    if (!productId) {
      return { success: false, error: 'Product ID is required for Gumroad verification' };
    }

    const gumroadAdapter = new GumroadAdapter({
      clientId: config.gumroadClientId ?? '',
      clientSecret: config.gumroadClientSecret ?? '',
      redirectUri: `${config.baseUrl}/api/verification/callback/gumroad`,
    });

    logger.info('[gumroadHandler] Calling Gumroad verifyLicense', {
      productId,
      licenseKeyPrefix: licenseKey.slice(0, 8),
      licenseKeyLength: licenseKey.length,
      tenantId,
    });

    const result = await gumroadAdapter.verifyLicense(licenseKey, productId);

    logger.info('[gumroadHandler] Gumroad verifyLicense result', {
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

    const providerUserId = result.purchaseEmail ?? `gumroad:${productId}:${licenseKey.slice(0, 8)}`;
    const sourceReference = result.saleId ?? `gumroad:${productId}:${licenseKey}`;

    const mutationResult = await convex.mutation(
      api.licenseVerification.completeLicenseVerification,
      {
        apiSecret: config.convexApiSecret,
        tenantId,
        subjectId,
        provider: 'gumroad',
        providerUserId,
        providerMetadata: result.purchaseEmail ? { email: result.purchaseEmail } : undefined,
        productsToGrant: [{ productId, sourceReference }],
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
  },
};
