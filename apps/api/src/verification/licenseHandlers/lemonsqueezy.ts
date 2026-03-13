import { LemonSqueezyApiClient } from '@yucp/providers';
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

type CatalogMapping = {
  catalogProductId?: string;
  localProductId?: string;
  externalVariantId?: string;
  externalProductId?: string;
};

type CatalogProduct = { _id: string; productId: string; providerProductRef: string };

/** Resolve which catalog/local product a set of provider refs map to. */
function resolveCatalogMatch(
  mappings: CatalogMapping[],
  catalogProducts: CatalogProduct[],
  providerRefs: Array<string | undefined | null>
) {
  const refs = providerRefs.filter((v): v is string => Boolean(v));
  for (const ref of refs) {
    const mapping = mappings.find(
      (m) => m.externalVariantId === ref || m.externalProductId === ref
    );
    if (mapping?.catalogProductId || mapping?.localProductId) {
      return { catalogProductId: mapping.catalogProductId, productId: mapping.localProductId };
    }
  }
  for (const ref of refs) {
    const catalog = catalogProducts.find((c) => c.providerProductRef === ref);
    if (catalog) return { catalogProductId: catalog._id, productId: catalog.productId };
  }
  return { catalogProductId: undefined, productId: undefined };
}

export const lemonSqueezyHandler: LicenseVerificationHandler = {
  async verify(
    input: CompleteLicenseInput,
    config: VerificationConfig,
    convex: ConvexServerClient
  ): Promise<CompleteLicenseResult> {
    const { licenseKey, authUserId, subjectId } = input;

    // Get the LS connection and decrypt the API token
    const secrets = await convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: config.convexApiSecret,
      authUserId,
      provider: 'lemonsqueezy',
    });

    const encryptedApiToken = secrets?.lemonApiTokenEncrypted;
    if (!encryptedApiToken) {
      return {
        success: false,
        error: 'Lemon Squeezy API key not configured. Connect your store in `/creator setup`.',
      };
    }

    if (!config.encryptionSecret) {
      return { success: false, error: 'API key decryption not configured.' };
    }

    let apiToken: string;
    try {
      apiToken = await decrypt(encryptedApiToken, config.encryptionSecret);
    } catch (err) {
      logger.error('Failed to decrypt Lemon Squeezy API token', { authUserId, err });
      return {
        success: false,
        error:
          'Failed to decrypt stored API token. Re-connect your Lemon Squeezy store in `/creator setup`.',
      };
    }

    const client = new LemonSqueezyApiClient({ apiToken });
    const validation = await client.validateLicenseKey(licenseKey);

    if (!validation.valid || !validation.license_key) {
      return {
        success: false,
        error: sanitizePublicErrorMessage(
          validation.error,
          'License is invalid or could not be validated'
        ),
      };
    }

    const licenseId =
      validation.license_key.id != null
        ? String(validation.license_key.id)
        : validation.meta?.order_item_id != null
          ? String(validation.meta.order_item_id)
          : null;

    if (!licenseId) {
      return { success: false, error: 'License validation did not return a license ID.' };
    }
    const productId = validation.meta?.product_id;
    const variantId = validation.meta?.variant_id;
    const customerId = validation.meta?.customer_id
      ? String(validation.meta.customer_id)
      : undefined;
    const userEmail = validation.meta?.user_email ?? undefined;
    const userName = validation.meta?.user_name ?? undefined;

    // Find the connection record (needed for catalog mapping lookup)
    const connectionsResult = await convex.query(api.providerConnections.listConnections, {
      apiSecret: config.convexApiSecret,
      authUserId,
    });
    const connection = (
      connectionsResult.connections as Array<{
        id: string;
        providerKey?: string;
        provider?: string;
      }>
    ).find((c) => c.providerKey === 'lemonsqueezy' || c.provider === 'lemonsqueezy');

    if (!connection) {
      return {
        success: false,
        error: 'Lemon Squeezy connection record not found. Please re-connect your store.',
      };
    }

    // Resolve which product this license maps to
    const [mappings, catalogProducts] = await Promise.all([
      convex.query(api.providerPlatform.listCatalogMappingsForConnection, {
        apiSecret: config.convexApiSecret,
        providerConnectionId: connection.id,
      }),
      convex.query(api.providerPlatform.listCatalogProductsForTenant, {
        apiSecret: config.convexApiSecret,
        authUserId,
      }),
    ]);

    const match = resolveCatalogMatch(
      mappings as CatalogMapping[],
      catalogProducts as CatalogProduct[],
      [variantId ? String(variantId) : undefined, productId ? String(productId) : undefined]
    );

    if (!match.productId) {
      return {
        success: false,
        error:
          'No matching product found for this Lemon Squeezy license. Make sure the product is added in `/creator-admin product add`.',
      };
    }

    const normalizedEmail = userEmail ? normalizeEmail(userEmail) : undefined;

    logger.info('[lemonSqueezyHandler] License validated, granting entitlement', {
      authUserId,
      licenseId,
      productId: match.productId,
      catalogProductId: match.catalogProductId,
    });

    const mutationResult = await convex.mutation(
      api.licenseVerification.completeLicenseVerification,
      {
        apiSecret: config.convexApiSecret,
        authUserId,
        subjectId,
        provider: 'lemonsqueezy',
        providerUserId: String(customerId ?? userEmail ?? licenseId),
        providerUsername: userName,
        providerMetadata: normalizedEmail ? { email: normalizedEmail } : undefined,
        productsToGrant: [
          {
            productId: match.productId,
            catalogProductId: match.catalogProductId,
            sourceReference: `lemonsqueezy:license:${licenseId}`,
          },
        ],
      }
    );

    // Retroactively sync all purchases for this buyer across all of the tenant's LS products
    if (mutationResult.success && normalizedEmail) {
      try {
        const emailHash = await sha256Hex(normalizedEmail);
        await convex.mutation(api.backgroundSync.scheduleBackfillThenSyncForBuyer, {
          apiSecret: config.convexApiSecret,
          authUserId,
          subjectId,
          provider: 'lemonsqueezy',
          emailHash,
          providerUserId: String(customerId ?? licenseId),
        });
      } catch (syncErr) {
        logger.warn('[lemonSqueezyHandler] Post-verify buyer sync scheduling failed (non-fatal)', {
          authUserId,
          subjectId,
          error: syncErr instanceof Error ? syncErr.message : String(syncErr),
        });
      }
    }

    return {
      success: mutationResult.success,
      provider: 'lemonsqueezy',
      entitlementIds: mutationResult.entitlementIds,
      error: sanitizePublicErrorMessage(
        mutationResult.error,
        'The license could not be verified right now.'
      ),
    };
  },
};
