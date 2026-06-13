/**
 * Complete License Verification - Provider-agnostic dispatcher
 *
 * API handler for POST /api/verification/complete-license
 *
 * Dispatches to the appropriate provider plugin via the licenseHandlers registry adapter.
 * Adding support for a new provider requires only:
 *   1. Implementing providers/{provider}/verification.ts
 *   2. Registering the provider plugin in providers/index.ts
 */

import { detectLicenseFormat } from '@yucp/providers';
import { getConvexClientFromUrl } from '../lib/convex';
import { logger } from '../lib/logger';
import { ensureSubjectAuthUserId, SUBJECT_AUTH_USER_REQUIRED_ERROR } from '../lib/subjectIdentity';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';
import { getHandler } from './licenseHandlers/index';
import type { VerificationConfig } from './verificationConfig';

interface CompleteLicenseBaseInput {
  /** License key to verify */
  licenseKey: string;
  /** Provider key (e.g. 'gumroad', 'jinxxy', 'lemonsqueezy'). If omitted, auto-detected from key format. */
  provider?: string;
  /** Provider product reference - required for Gumroad */
  productId?: string;
}

interface CompleteLicenseLegacyIdentityInput {
  /** Single-actor legacy identity, used when the buyer and creator are the same account. */
  authUserId: string;
  /** Subject ID (from Discord session) */
  subjectId: string;
  creatorAuthUserId?: never;
  buyerAuthUserId?: never;
  buyerSubjectId?: never;
}

interface CompleteLicenseExplicitIdentityInput {
  /** Creator Identity that owns the product and store credentials used for verification. */
  creatorAuthUserId: string;
  /** Buyer account that should own the linked external account. */
  buyerAuthUserId: string;
  /** Buyer subject that should receive the account link and verification evidence. */
  buyerSubjectId: string;
  authUserId?: never;
  subjectId?: never;
}

export type CompleteLicenseInput = CompleteLicenseBaseInput &
  (CompleteLicenseLegacyIdentityInput | CompleteLicenseExplicitIdentityInput);

export interface ResolvedCompleteLicenseInput extends CompleteLicenseBaseInput {
  creatorAuthUserId: string;
  buyerAuthUserId: string;
  buyerSubjectId: string;
  identityMode: 'legacy' | 'explicit';
}

export interface CompleteLicenseResult {
  success: boolean;
  provider?: string;
  entitlementIds?: string[];
  error?: string;
}

function resolveCompleteLicenseInput(
  input: CompleteLicenseInput
): { ok: true; value: ResolvedCompleteLicenseInput } | { ok: false; error: string } {
  const hasLegacyIdentity = 'authUserId' in input || 'subjectId' in input;
  const hasExplicitIdentity =
    'creatorAuthUserId' in input || 'buyerAuthUserId' in input || 'buyerSubjectId' in input;

  if (hasLegacyIdentity && hasExplicitIdentity) {
    return {
      ok: false,
      error:
        'Provide either authUserId/subjectId or creatorAuthUserId/buyerAuthUserId/buyerSubjectId',
    };
  }

  if (hasExplicitIdentity) {
    const { creatorAuthUserId, buyerAuthUserId, buyerSubjectId } =
      input as CompleteLicenseExplicitIdentityInput;
    if (!creatorAuthUserId) return { ok: false, error: 'Missing creator auth user ID' };
    if (!buyerAuthUserId) return { ok: false, error: 'Missing buyer auth user ID' };
    if (!buyerSubjectId) return { ok: false, error: 'Missing buyer subject ID' };

    return {
      ok: true,
      value: {
        licenseKey: input.licenseKey,
        provider: input.provider,
        productId: input.productId,
        creatorAuthUserId,
        buyerAuthUserId,
        buyerSubjectId,
        identityMode: 'explicit',
      },
    };
  }

  const { authUserId, subjectId } = input as CompleteLicenseLegacyIdentityInput;
  if (!authUserId) return { ok: false, error: 'Missing auth user ID' };
  if (!subjectId) return { ok: false, error: 'Missing subject ID' };

  return {
    ok: true,
    value: {
      licenseKey: input.licenseKey,
      provider: input.provider,
      productId: input.productId,
      creatorAuthUserId: authUserId,
      buyerAuthUserId: authUserId,
      buyerSubjectId: subjectId,
      identityMode: 'legacy',
    },
  };
}

/**
 * Handle complete-license verification.
 * Resolves the provider, finds the registered handler, and delegates.
 */
export async function handleCompleteLicense(
  config: VerificationConfig,
  input: CompleteLicenseInput
): Promise<CompleteLicenseResult> {
  const { licenseKey } = input;

  if (!licenseKey?.trim()) return { success: false, error: 'Missing license key' };

  const resolvedInput = resolveCompleteLicenseInput(input);
  if (!resolvedInput.ok) {
    return { success: false, error: resolvedInput.error };
  }

  if (!config.convexUrl || !config.convexApiSecret) {
    return { success: false, error: 'Verification not configured' };
  }

  // Use explicit provider if supplied; fall back to format detection for backward compat
  let providerKey = input.provider?.trim() || undefined;
  if (!providerKey) {
    const detected = detectLicenseFormat(licenseKey.trim());
    if (detected === 'unknown') return { success: false, error: 'Unknown license format' };
    providerKey = detected;
  }

  const handler = getHandler(providerKey);
  if (!handler) {
    return { success: false, error: `Unsupported provider: ${providerKey}` };
  }

  const convex = getConvexClientFromUrl(config.convexUrl);
  let verificationInput = resolvedInput.value;
  if (resolvedInput.value.identityMode === 'legacy') {
    const buyerAuthUserId = await ensureSubjectAuthUserId(
      convex,
      config.convexApiSecret,
      resolvedInput.value.buyerSubjectId
    );
    if (!buyerAuthUserId) {
      return { success: false, error: SUBJECT_AUTH_USER_REQUIRED_ERROR };
    }
    verificationInput = {
      ...resolvedInput.value,
      buyerAuthUserId,
    };
  }

  logger.info('[completeLicense] Dispatching to provider handler', {
    providerKey,
    creatorAuthUserId: verificationInput.creatorAuthUserId,
    buyerAuthUserId: verificationInput.buyerAuthUserId,
    licenseKeyPrefix: licenseKey.trim().slice(0, 8),
  });
  const { identityMode: _identityMode, ...handlerInput } = verificationInput;

  try {
    return await handler.verify({ ...handlerInput, licenseKey: licenseKey.trim() }, config, convex);
  } catch (err) {
    logger.error('License verification handler threw', {
      error: err instanceof Error ? err.message : String(err),
      providerKey,
      creatorAuthUserId: resolvedInput.value.creatorAuthUserId,
      buyerAuthUserId: resolvedInput.value.buyerAuthUserId,
    });
    return {
      success: false,
      error: sanitizePublicErrorMessage(
        err instanceof Error ? err.message : String(err),
        'The license could not be verified right now.'
      ),
    };
  }
}
