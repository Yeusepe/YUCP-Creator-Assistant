import { JinxxyApiClient } from '@yucp/providers';
import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import type { ConvexServerClient } from '../../lib/convex';
import { decrypt } from '../../lib/encrypt';
import { sanitizePublicErrorMessage } from '../../lib/userFacingErrors';
import type { CompleteLicenseInput, CompleteLicenseResult } from '../completeLicense';
import type { VerificationConfig } from '../sessionManager';
import type { LicenseVerificationHandler } from './index';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function resolveJinxxyApiKey(
  convex: ConvexServerClient,
  config: VerificationConfig,
  tenantId: string
): Promise<{ key: string } | { error: string }> {
  let encrypted: string | null = null;

  const conn = await convex.query(api.providerConnections.getConnectionForBackfill, {
    apiSecret: config.convexApiSecret,
    tenantId,
    provider: 'jinxxy',
  });
  if (conn?.jinxxyApiKeyEncrypted) {
    encrypted = conn.jinxxyApiKeyEncrypted;
  }

  if (!encrypted) {
    encrypted = await convex.query(api.tenantConfig.getJinxxyApiKeyForVerification, {
      apiSecret: config.convexApiSecret,
      tenantId,
    });
  }

  if (!encrypted) {
    return {
      error: 'Jinxxy API key not configured. Add your Jinxxy API key in `/creator setup`.',
    };
  }

  if (!config.encryptionSecret) {
    return {
      error: 'Jinxxy API key decryption not configured (BETTER_AUTH_SECRET required).',
    };
  }

  try {
    const key = await decrypt(encrypted, config.encryptionSecret);
    return { key };
  } catch (err) {
    logger.error('Failed to decrypt tenant Jinxxy API key', { tenantId, err });
    return {
      error: 'Failed to decrypt stored Jinxxy API key. Re-add your key in `/creator setup`.',
    };
  }
}

export const jinxxyHandler: LicenseVerificationHandler = {
  async verify(
    input: CompleteLicenseInput,
    config: VerificationConfig,
    convex: ConvexServerClient
  ): Promise<CompleteLicenseResult> {
    const { licenseKey, tenantId, subjectId } = input;

    const keyResult = await resolveJinxxyApiKey(convex, config, tenantId);
    if ('error' in keyResult) return { success: false, error: keyResult.error };

    const jinxxyClient = new JinxxyApiClient({
      apiKey: keyResult.key,
      apiBaseUrl: process.env.JINXXY_API_BASE_URL,
    });

    const verifyResult = await jinxxyClient.verifyLicenseByKey(licenseKey);
    if (!verifyResult.valid || !verifyResult.license) {
      return {
        success: false,
        error: sanitizePublicErrorMessage(verifyResult.error, 'License verification failed'),
      };
    }

    const license = verifyResult.license;
    if (!license.product_id) {
      return { success: false, error: 'License has no product - cannot grant entitlement' };
    }

    const customerId = license.customer_id ?? license.id;

    const mutationResult = await convex.mutation(
      api.licenseVerification.completeLicenseVerification,
      {
        apiSecret: config.convexApiSecret,
        tenantId,
        subjectId,
        provider: 'jinxxy',
        providerUserId: customerId,
        productsToGrant: [
          {
            productId: license.product_id,
            sourceReference: `jinxxy:license:${license.id}`,
          },
        ],
      }
    );

    if (mutationResult.success) {
      // Retroactively sync all purchases for this buyer across all of the tenant's Jinxxy products
      try {
        const orderId = license.order_id;
        if (orderId) {
          const order = await jinxxyClient.getOrder(orderId);
          if (order?.email) {
            const emailHash = await sha256Hex(normalizeEmail(order.email));
            await convex.mutation(api.backgroundSync.scheduleBackfillThenSyncForBuyer, {
              apiSecret: config.convexApiSecret,
              tenantId,
              subjectId,
              provider: 'jinxxy',
              emailHash,
              providerUserId: customerId,
            });
          }
        }
      } catch (syncErr) {
        logger.warn('[jinxxyHandler] Post-verify buyer sync scheduling failed (non-fatal)', {
          tenantId,
          subjectId,
          error: syncErr instanceof Error ? syncErr.message : String(syncErr),
        });
      }
      return { success: true, provider: 'jinxxy', entitlementIds: mutationResult.entitlementIds };
    }

    // Primary key failed — try collaborator connections
    const collabConnections = (await convex.query(
      api.collaboratorInvites.getCollabConnectionsForVerification,
      { apiSecret: config.convexApiSecret, ownerTenantId: tenantId }
    )) as Array<{ id: string; jinxxyApiKeyEncrypted?: string }>;

    for (const collab of collabConnections) {
      if (!collab.jinxxyApiKeyEncrypted) continue;
      try {
        const collabKey = await decrypt(
          collab.jinxxyApiKeyEncrypted,
          config.encryptionSecret ?? ''
        );
        const collabClient = new JinxxyApiClient({
          apiKey: collabKey,
          apiBaseUrl: process.env.JINXXY_API_BASE_URL,
        });
        const collabResult = await collabClient.verifyLicenseByKey(licenseKey);
        if (collabResult.valid && collabResult.license) {
          const cl = collabResult.license;
          if (!cl.product_id) continue;
          const collabMutation = await convex.mutation(
            api.licenseVerification.completeLicenseVerification,
            {
              apiSecret: config.convexApiSecret,
              tenantId,
              subjectId,
              provider: 'jinxxy',
              providerUserId: cl.customer_id ?? cl.id,
              productsToGrant: [
                {
                  productId: cl.product_id,
                  sourceReference: `jinxxy-collab:${collab.id}:license:${cl.id}`,
                },
              ],
            }
          );
          if (collabMutation.success) {
            return {
              success: true,
              provider: 'jinxxy',
              entitlementIds: collabMutation.entitlementIds,
            };
          }
        }
      } catch (collabErr) {
        logger.warn('Collab Jinxxy verification failed', {
          collabConnectionId: collab.id,
          error: collabErr instanceof Error ? collabErr.message : String(collabErr),
        });
      }
    }

    return {
      success: mutationResult.success,
      provider: 'jinxxy',
      entitlementIds: mutationResult.entitlementIds,
      error: sanitizePublicErrorMessage(
        mutationResult.error,
        'The license could not be verified right now.'
      ),
    };
  },
};
