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
import { encryptForensicsLicenseKey } from '../forensicsLicenseKey';
import type { VerificationConfig } from '../verificationConfig';

function resolveHandlerActors(input: CompleteLicenseInput): {
  creatorAuthUserId: string;
  buyerAuthUserId: string;
  buyerSubjectId: string;
} {
  if (
    'creatorAuthUserId' in input &&
    typeof input.creatorAuthUserId === 'string' &&
    typeof input.buyerAuthUserId === 'string' &&
    typeof input.buyerSubjectId === 'string'
  ) {
    return {
      creatorAuthUserId: input.creatorAuthUserId,
      buyerAuthUserId: input.buyerAuthUserId,
      buyerSubjectId: input.buyerSubjectId,
    };
  }

  return {
    creatorAuthUserId: input.authUserId,
    buyerAuthUserId: input.authUserId,
    buyerSubjectId: input.subjectId,
  };
}

function buildProviderSourceReference(args: {
  provider: string;
  externalOrderId?: string;
  externalLicenseId?: string;
  fallbackDigest: string;
}): string {
  if (args.externalOrderId && args.externalLicenseId) {
    return `${args.provider}:${args.externalOrderId}:${args.externalLicenseId}`;
  }
  if (args.externalOrderId) {
    return `${args.provider}:${args.externalOrderId}`;
  }
  return `${args.provider}:${args.fallbackDigest.slice(0, 16)}`;
}

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
      const { licenseKey, productId } = input;
      const { creatorAuthUserId, buyerAuthUserId, buyerSubjectId } = resolveHandlerActors(input);
      const ctx = {
        convex,
        apiSecret: config.convexApiSecret,
        authUserId: creatorAuthUserId,
        encryptionSecret: config.encryptionSecret ?? '',
      };

      let result: Awaited<ReturnType<typeof verification.verifyLicense>>;
      try {
        result = await verification.verifyLicense(
          licenseKey,
          productId ?? '',
          creatorAuthUserId,
          ctx
        );
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
      const sourceReference = buildProviderSourceReference({
        provider,
        externalOrderId: result.externalOrderId,
        externalLicenseId: result.externalLicenseId,
        fallbackDigest: licenseKeyDigest,
      });
      const encryptedLicenseKey = await encryptForensicsLicenseKey(
        licenseKey,
        config.encryptionSecret ?? ''
      );

      logger.info('[licenseHandlers] Granting entitlement', {
        provider,
        creatorAuthUserId,
        buyerAuthUserId,
        productId,
      });

      let mutationResult: Awaited<ReturnType<typeof convex.mutation>>;
      try {
        mutationResult = await convex.mutation(
          api.licenseVerification.completeLicenseVerification,
          {
            apiSecret: config.convexApiSecret,
            creatorAuthUserId,
            buyerAuthUserId,
            subjectId: buyerSubjectId,
            provider,
            providerUserId,
            productsToGrant: [
              {
                productId: result.providerProductId ?? productId ?? '',
                sourceReference,
                providerTierRefs: result.providerTierRef ? [result.providerTierRef] : undefined,
              },
            ],
            licenseSubjectLink: {
              licenseSubject: licenseKeyDigest,
              licenseKeyEncrypted: encryptedLicenseKey,
              providerProductId: result.providerProductId ?? productId ?? undefined,
            },
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
