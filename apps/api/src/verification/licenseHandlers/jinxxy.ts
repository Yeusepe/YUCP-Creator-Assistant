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
  authUserId: string
): Promise<{ key: string } | { error: string }> {
  let encrypted: string | null = null;

  const conn = await convex.query(api.providerConnections.getConnectionForBackfill, {
    apiSecret: config.convexApiSecret,
    authUserId,
    provider: 'jinxxy',
  });
  if (conn?.jinxxyApiKeyEncrypted) {
    encrypted = conn.jinxxyApiKeyEncrypted;
  }

  if (!encrypted) {
    encrypted = await convex.query(api.creatorConfig.getJinxxyApiKeyForVerification, {
      apiSecret: config.convexApiSecret,
      authUserId,
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
    logger.error('Failed to decrypt tenant Jinxxy API key', { authUserId, err });
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
    const { licenseKey, authUserId, subjectId } = input;

    const keyResult = await resolveJinxxyApiKey(convex, config, authUserId);
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
        authUserId,
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
      // Retroactively sync all purchases for this buyer across all of the tenant's Jinxxy products.
      // Jinxxy API doesn't return email on orders, so we match by providerUserId (customerId).
      // If the order happens to have email, we also use emailHash for broader matching.
      try {
        const orderId = license.order_id;
        logger.info('[jinxxyHandler] Post-verify sync: starting', {
          authUserId,
          subjectId,
          licenseId: license.id,
          orderId: orderId ?? '(null)',
          customerId,
        });

        let emailHash: string | undefined;

        if (orderId) {
          logger.info('[jinxxyHandler] Post-verify sync: fetching order for email', { orderId });
          const order = await jinxxyClient.getOrder(orderId);
          if (order?.email) {
            emailHash = await sha256Hex(normalizeEmail(order.email));
            logger.info('[jinxxyHandler] Post-verify sync: got email from order', {
              orderId,
              emailHashPrefix: emailHash.slice(0, 8),
            });
          } else {
            logger.info(
              '[jinxxyHandler] Post-verify sync: order has no email, using providerUserId only',
              { orderId, customerId }
            );
          }
        }

        logger.info('[jinxxyHandler] Post-verify sync: scheduling backfill', {
          authUserId,
          subjectId,
          providerUserId: customerId,
          hasEmailHash: !!emailHash,
        });

        await convex.mutation(api.backgroundSync.scheduleBackfillThenSyncForBuyer, {
          apiSecret: config.convexApiSecret,
          authUserId,
          subjectId,
          provider: 'jinxxy',
          emailHash,
          providerUserId: customerId,
        });

        logger.info('[jinxxyHandler] Post-verify sync: scheduled successfully', {
          authUserId,
          subjectId,
        });
      } catch (syncErr) {
        logger.warn('[jinxxyHandler] Post-verify buyer sync scheduling failed (non-fatal)', {
          authUserId,
          subjectId,
          error: syncErr instanceof Error ? syncErr.message : String(syncErr),
          stack: syncErr instanceof Error ? syncErr.stack : undefined,
        });
      }
      return { success: true, provider: 'jinxxy', entitlementIds: mutationResult.entitlementIds };
    }

    // Primary key failed, try collaborator connections
    const collabConnections = (await convex.query(
      api.collaboratorInvites.getCollabConnectionsForVerification,
      { apiSecret: config.convexApiSecret, ownerAuthUserId: authUserId }
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
              authUserId,
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
            try {
              const collabCustomerId = cl.customer_id ? String(cl.customer_id) : undefined;
              if (collabCustomerId) {
                await convex.mutation(api.backgroundSync.scheduleBackfillThenSyncForBuyer, {
                  apiSecret: config.convexApiSecret,
                  authUserId,
                  subjectId,
                  provider: 'jinxxy',
                  emailHash: undefined,
                  providerUserId: collabCustomerId,
                });
              }
            } catch (syncErr) {
              logger.warn('[jinxxyHandler] Collab post-verify buyer sync failed (non-fatal)', {
                authUserId,
                subjectId,
                error: syncErr instanceof Error ? syncErr.message : String(syncErr),
              });
            }
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
