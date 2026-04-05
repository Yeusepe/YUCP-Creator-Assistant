import { JinxxyApiClient } from '@yucp/providers';
import { getJinxxyProviderRuntimeConfig } from '../runtimeConfig';
import type {
  LicenseVerificationPlugin,
  LicenseVerificationResult,
  ProviderContext,
} from '../types';
import { resolveJinxxyCreatorApiKey } from './credentials';

export const verification: LicenseVerificationPlugin = {
  async verifyLicense(
    licenseKey: string,
    _productId: string | undefined,
    authUserId: string,
    ctx: ProviderContext
  ): Promise<LicenseVerificationResult | null> {
    const apiKey = await resolveJinxxyCreatorApiKey(ctx, authUserId);
    if (!apiKey) {
      return {
        valid: false,
        error: 'Jinxxy API key not configured. Add your Jinxxy API key in `/creator setup`.',
      };
    }

    const client = new JinxxyApiClient({
      apiKey,
      apiBaseUrl: getJinxxyProviderRuntimeConfig().apiBaseUrl,
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
