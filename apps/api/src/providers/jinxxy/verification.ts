import { JinxxyApiClient } from '@yucp/providers';
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
const CREDENTIAL_PURPOSE = 'jinxxy-api-key' as const;

async function resolveJinxxyApiKey(
  ctx: ProviderContext,
  authUserId: string
): Promise<string | null> {
  const data = await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
    apiSecret: ctx.apiSecret,
    authUserId,
    provider: 'jinxxy',
  });
  const encryptedKey = data?.credentials.api_key;
  if (!encryptedKey) return null;

  try {
    return await decrypt(encryptedKey, ctx.encryptionSecret, CREDENTIAL_PURPOSE);
  } catch (err) {
    logger.error('Failed to decrypt Jinxxy API key', { authUserId, err });
    return null;
  }
}

export const verification: LicenseVerificationPlugin = {
  async verifyLicense(
    licenseKey: string,
    _productId: string | undefined,
    authUserId: string,
    ctx: ProviderContext
  ): Promise<LicenseVerificationResult | null> {
    const apiKey = await resolveJinxxyApiKey(ctx, authUserId);
    if (!apiKey) {
      return {
        valid: false,
        error: 'Jinxxy API key not configured. Add your Jinxxy API key in `/creator setup`.',
      };
    }

    const client = new JinxxyApiClient({
      apiKey,
      apiBaseUrl: process.env.JINXXY_API_BASE_URL,
    });

    const result = await client.verifyLicenseByKey(licenseKey);

    return {
      valid: result.valid,
      externalOrderId: result.license?.order_id ?? result.license?.id ?? undefined,
      providerProductId: result.license?.product_id ?? undefined,
      error: result.error ?? undefined,
    };
  },
};
