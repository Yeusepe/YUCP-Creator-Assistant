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

import { sha256Hex } from '@yucp/shared/crypto';
import { api } from '../../../../../convex/_generated/api';
import type { ConvexServerClient } from '../../lib/convex';
import { logger } from '../../lib/logger';
import { sanitizePublicErrorMessage } from '../../lib/userFacingErrors';
import { getProviderRuntime } from '../../providers/index';
import type { CompleteLicenseInput, CompleteLicenseResult } from '../completeLicense';
import type { VerificationConfig } from '../verificationConfig';

export interface LicenseVerificationHandler {
  verify(
    input: CompleteLicenseInput,
    config: VerificationConfig,
    convex: ConvexServerClient
  ): Promise<CompleteLicenseResult>;
}

export function getHandler(provider: string): LicenseVerificationHandler | null {
  const verification = getProviderRuntime(provider)?.verification;
  if (!verification) return null;

  return {
    async verify(input, config, convex) {
      const { licenseKey, productId, authUserId, subjectId } = input;
      const ctx = {
        convex,
        apiSecret: config.convexApiSecret,
        authUserId,
        encryptionSecret: config.encryptionSecret ?? '',
      };

      let result: Awaited<ReturnType<typeof verification.verifyLicense>>;
      try {
        result = await verification.verifyLicense(licenseKey, productId, authUserId, ctx);
      } catch (err) {
        logger.error('[licenseHandlers] verifyLicense threw', {
          provider,
          error: err instanceof Error ? err.message : String(err),
        });
        return { success: false, error: 'License verification failed' };
      }
      if (!result) {
        return { success: false, error: 'Invalid license key' };
      }
      if (!result.valid) {
        return {
          success: false,
          error: sanitizePublicErrorMessage(result.error, 'License verification failed'),
        };
      }

      const licenseKeyDigest = await sha256Hex(licenseKey);
      const providerUserId =
        result.providerUserId ??
        `${provider}:${productId ?? 'noproduct'}:${licenseKeyDigest.slice(0, 16)}`;
      const sourceReference =
        result.externalOrderId ?? `${provider}:${licenseKeyDigest.slice(0, 16)}`;

      logger.info('[licenseHandlers] Granting entitlement', {
        provider,
        authUserId,
        productId,
      });

      let mutationResult: Awaited<ReturnType<typeof convex.mutation>>;
      try {
        mutationResult = await convex.mutation(
          api.licenseVerification.completeLicenseVerification,
          {
            apiSecret: config.convexApiSecret,
            authUserId,
            subjectId,
            provider,
            providerUserId,
            productsToGrant: [
              { productId: result.providerProductId ?? productId ?? '', sourceReference },
            ],
          }
        );
      } catch (err) {
        logger.error('[licenseHandlers] completeLicenseVerification threw', {
          provider,
          error: err instanceof Error ? err.message : String(err),
        });
        return { success: false, error: 'License verification failed' };
      }

      return {
        success: mutationResult.success,
        provider,
        entitlementIds: mutationResult.entitlementIds,
        error: sanitizePublicErrorMessage(mutationResult.error, 'License verification failed'),
      };
    },
  };
}
