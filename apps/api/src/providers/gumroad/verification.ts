import { GumroadAdapter } from '@yucp/providers';
import { createLogger } from '@yucp/shared';
import type { LicenseVerificationPlugin, LicenseVerificationResult } from '../types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export const verification: LicenseVerificationPlugin = {
  async verifyLicense(
    licenseKey: string,
    productId: string | undefined,
    authUserId: string,
    _ctx,
  ): Promise<LicenseVerificationResult | null> {
    if (!productId) {
      return { valid: false, error: 'Product ID is required for Gumroad verification' };
    }

    const gumroadAdapter = new GumroadAdapter({
      clientId: process.env.GUMROAD_CLIENT_ID ?? '',
      clientSecret: process.env.GUMROAD_CLIENT_SECRET ?? '',
      redirectUri: '',
    });

    logger.info('[gumroad/verification] Calling Gumroad verifyLicense', {
      productId,
      licenseKeyPrefix: licenseKey.slice(0, 8),
      licenseKeyLength: licenseKey.length,
      authUserId,
    });

    const result = await gumroadAdapter.verifyLicense(licenseKey, productId);

    logger.info('[gumroad/verification] Gumroad verifyLicense result', {
      valid: result.valid,
      error: result.error,
      saleId: result.saleId,
    });

    return {
      valid: result.valid,
      externalOrderId: result.saleId ?? undefined,
      providerUserId: result.purchaseEmail ?? undefined,
      error: result.error ?? undefined,
    };
  },
};
