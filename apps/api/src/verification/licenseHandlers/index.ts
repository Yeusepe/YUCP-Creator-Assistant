/**
 * License Verification Handler Registry
 *
 * Wraps each provider's LicenseVerificationPlugin into the LicenseVerificationHandler
 * interface used by completeLicense.ts. The entitlement-creation Convex mutation is
 * executed here so individual plugins only need to verify against the provider API.
 *
 * Adding a new provider: implement LicenseVerificationPlugin in providers/{name}/verification.ts
 * and register the plugin in providers/index.ts. Nothing here changes.
 */

import { api } from '../../../../../convex/_generated/api';
import { createLogger } from '@yucp/shared';
import { getProvider } from '../../providers/index';
import { sanitizePublicErrorMessage } from '../../lib/userFacingErrors';
import type { ConvexServerClient } from '../../lib/convex';
import type { CompleteLicenseInput, CompleteLicenseResult } from '../completeLicense';
import type { VerificationConfig } from '../sessionManager';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export interface LicenseVerificationHandler {
  verify(
    input: CompleteLicenseInput,
    config: VerificationConfig,
    convex: ConvexServerClient,
  ): Promise<CompleteLicenseResult>;
}

export async function getHandler(provider: string): Promise<LicenseVerificationHandler | null> {
  const plugin = getProvider(provider)?.verification;
  if (!plugin) return null;

  return {
    async verify(input, config, convex) {
      const { licenseKey, productId, authUserId, subjectId } = input;
      const ctx = {
        convex,
        apiSecret: config.convexApiSecret,
        authUserId,
        encryptionSecret: config.encryptionSecret ?? '',
      };

      const result = await plugin.verifyLicense(licenseKey, productId, authUserId, ctx);
      if (!result) {
        return { success: false, error: 'Invalid license key' };
      }
      if (!result.valid) {
        return {
          success: false,
          error: sanitizePublicErrorMessage(result.error, 'License verification failed'),
        };
      }

      const providerUserId =
        result.providerUserId ??
        `${provider}:${productId ?? 'noproduct'}:${licenseKey.slice(0, 8)}`;
      const sourceReference =
        result.externalOrderId ?? `${provider}:${licenseKey.slice(0, 16)}`;

      logger.info('[licenseHandlers] Granting entitlement', {
        provider,
        authUserId,
        productId,
      });

      const mutationResult = await convex.mutation(
        api.licenseVerification.completeLicenseVerification,
        {
          apiSecret: config.convexApiSecret,
          authUserId,
          subjectId,
          provider,
          providerUserId,
          productsToGrant: [{ productId: productId ?? '', sourceReference }],
        },
      );

      return {
        success: mutationResult.success,
        provider,
        entitlementIds: mutationResult.entitlementIds,
        error: sanitizePublicErrorMessage(mutationResult.error, 'License verification failed'),
      };
    },
  };
}
