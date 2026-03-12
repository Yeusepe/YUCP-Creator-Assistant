/**
 * Complete License Verification - Provider-agnostic dispatcher
 *
 * API handler for POST /api/verification/complete-license
 *
 * Dispatches to the appropriate provider handler via the HANDLERS registry.
 * Adding support for a new provider requires only:
 *   1. Creating apps/api/src/verification/licenseHandlers/{provider}.ts
 *   2. Adding a case to getHandler() in licenseHandlers/index.ts
 */

import { detectLicenseFormat } from '@yucp/providers';
import { createLogger } from '@yucp/shared';
import { getConvexClientFromUrl } from '../lib/convex';
import { sanitizePublicErrorMessage } from '../lib/userFacingErrors';
import { getHandler } from './licenseHandlers/index';
import type { VerificationConfig } from './sessionManager';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export interface CompleteLicenseInput {
  /** License key to verify */
  licenseKey: string;
  /** Provider key (e.g. 'gumroad', 'jinxxy', 'lemonsqueezy'). If omitted, auto-detected from key format. */
  provider?: string;
  /** Provider product reference - required for Gumroad */
  productId?: string;
  /** Tenant ID */
  tenantId: string;
  /** Subject ID (from Discord session) */
  subjectId: string;
}

export interface CompleteLicenseResult {
  success: boolean;
  provider?: string;
  entitlementIds?: string[];
  error?: string;
}

/**
 * Handle complete-license verification.
 * Resolves the provider, finds the registered handler, and delegates.
 */
export async function handleCompleteLicense(
  config: VerificationConfig,
  input: CompleteLicenseInput
): Promise<CompleteLicenseResult> {
  const { licenseKey, tenantId, subjectId } = input;

  if (!licenseKey?.trim()) return { success: false, error: 'Missing license key' };
  if (!tenantId) return { success: false, error: 'Missing tenant ID' };
  if (!subjectId) return { success: false, error: 'Missing subject ID' };

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

  const handler = await getHandler(providerKey);
  if (!handler) {
    return { success: false, error: `Unsupported provider: ${providerKey}` };
  }

  logger.info('[completeLicense] Dispatching to provider handler', {
    providerKey,
    tenantId,
    licenseKeyPrefix: licenseKey.trim().slice(0, 8),
  });

  const convex = getConvexClientFromUrl(config.convexUrl);

  try {
    return await handler.verify({ ...input, licenseKey: licenseKey.trim() }, config, convex);
  } catch (err) {
    logger.error('License verification handler threw', {
      error: err instanceof Error ? err.message : String(err),
      providerKey,
      tenantId,
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
