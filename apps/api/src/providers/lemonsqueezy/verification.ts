import { LemonSqueezyApiClient } from '@yucp/providers';
import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import { decrypt } from '../../lib/encrypt';
import type {
  LicenseVerificationPlugin,
  LicenseVerificationResult,
  ProviderContext,
} from '../types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

// HKDF purpose string — inlined to avoid circular imports with index.ts
const CREDENTIAL_PURPOSE = 'lemonsqueezy-api-token' as const;

export const verification: LicenseVerificationPlugin = {
  async verifyLicense(
    licenseKey: string,
    _productId: string | undefined,
    authUserId: string,
    ctx: ProviderContext,
  ): Promise<LicenseVerificationResult | null> {
    const secrets = await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: ctx.apiSecret,
      authUserId,
      provider: 'lemonsqueezy',
    });

    const encryptedApiToken = secrets?.lemonApiTokenEncrypted;
    if (!encryptedApiToken) {
      return {
        valid: false,
        error:
          'Lemon Squeezy API key not configured. Connect your store in `/creator setup`.',
      };
    }

    let apiToken: string;
    try {
      apiToken = await decrypt(encryptedApiToken, ctx.encryptionSecret, CREDENTIAL_PURPOSE);
    } catch (err) {
      logger.error('Failed to decrypt Lemon Squeezy API token', { authUserId, err });
      return {
        valid: false,
        error:
          'Failed to decrypt stored API token. Re-connect your Lemon Squeezy store in `/creator setup`.',
      };
    }

    const client = new LemonSqueezyApiClient({ apiToken });
    const validation = await client.validateLicenseKey(licenseKey);

    const licenseId =
      validation.license_key?.id != null
        ? String(validation.license_key.id)
        : validation.meta?.order_item_id != null
          ? String(validation.meta.order_item_id)
          : undefined;

    const productId = validation.meta?.product_id
      ? String(validation.meta.product_id)
      : undefined;

    return {
      valid: validation.valid,
      externalOrderId: licenseId,
      providerProductId: productId,
      error: validation.error ?? undefined,
    };
  },
};
