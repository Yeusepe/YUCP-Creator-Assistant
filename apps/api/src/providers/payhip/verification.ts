import { PayhipAdapter } from '@yucp/providers';
import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import { decrypt } from '../../lib/encrypt';
import type { LicenseVerificationPlugin, LicenseVerificationResult } from '../types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

// HKDF purpose string — must match the purpose used when storing product secret keys
const PRODUCT_SECRET_PURPOSE = 'payhip-product-secret' as const;

export const verification: LicenseVerificationPlugin = {
  async verifyLicense(
    licenseKey: string,
    _productId: string | undefined,
    authUserId: string,
    ctx
  ): Promise<LicenseVerificationResult | null> {
    const rawKeys = await ctx.convex.query(api.providerConnections.getPayhipProductSecretKeys, {
      apiSecret: ctx.apiSecret,
      authUserId,
    });

    if (rawKeys.length === 0) {
      return {
        valid: false,
        error: 'No product secret keys configured for this store. Contact the server owner.',
      };
    }

    const productKeys: Array<{ permalink: string; secretKey: string }> = [];
    for (const { permalink, encryptedSecretKey } of rawKeys) {
      try {
        const secretKey = await decrypt(
          encryptedSecretKey,
          ctx.encryptionSecret,
          PRODUCT_SECRET_PURPOSE
        );
        productKeys.push({ permalink, secretKey });
      } catch (err) {
        logger.warn('[payhip/verification] Failed to decrypt product secret key', {
          authUserId,
          permalink,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (productKeys.length === 0) {
      return {
        valid: false,
        error: 'Product secret keys could not be decrypted. Contact the server owner.',
      };
    }

    const adapter = new PayhipAdapter();
    const result = await adapter.verifyLicenseKey(licenseKey, productKeys);

    logger.info('[payhip/verification] verifyLicenseKey result', {
      authUserId,
      valid: result.valid,
      matchedPermalink: result.matchedProductPermalink,
    });

    return {
      valid: result.valid,
      providerProductId: result.matchedProductPermalink,
      error: result.error,
    };
  },
};
