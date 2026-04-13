/**
 * Payhip Provider Adapter
 *
 * Implements the ProviderAdapter interface for Payhip integration.
 * Supports license key verification (v2 per-product API) and webhook-based purchase tracking.
 *
 * Key design: Payhip license keys are verified per-product using a `product-secret-key`
 * header. To find which product a key belongs to, we scan all known product secret keys.
 *
 * Usage:
 * ```ts
 * const adapter = new PayhipAdapter();
 * const result = await adapter.verifyLicenseKey('WTKP4-66NL5-HMKQW-GFSCZ', [
 *   { permalink: 'RGsF', secretKey: 'PRODUCT_SECRET' }
 * ]);
 * ```
 */

import type { Verification } from '@yucp/shared';
import type { ProviderAdapter, ProviderConfig, PurchaseRecord } from '../legacyAdapter';
import { PayhipApiClient } from './client';
import type {
  PayhipAdapterConfig,
  PayhipEvidence,
  PayhipLicenseVerifyData,
  PayhipLicenseVerifyResult,
} from './types';
import { normalizeLicenseToEvidence, PayhipApiError } from './types';

export { PayhipApiClient };
export * from './types';

export interface PayhipProductKey {
  /** Product permalink (e.g., "RGsF"), matches `items[].product_key` in webhooks */
  permalink: string;
  /** Per-product secret key from Payhip product edit page */
  secretKey: string;
}

/**
 * Payhip provider adapter implementing the ProviderAdapter interface.
 */
export class PayhipAdapter implements ProviderAdapter {
  readonly name = 'payhip';

  private readonly client: PayhipApiClient;

  constructor(config?: ProviderConfig & PayhipAdapterConfig) {
    this.client = new PayhipApiClient({
      apiBaseUrl: config?.apiBaseUrl,
      timeout: config?.timeout,
      maxRetries: config?.maxRetries,
    });
  }

  // ============================================================================
  // PROVIDER ADAPTER INTERFACE
  // ============================================================================

  /**
   * Verify a purchase by email.
   * Payhip doesn't expose a direct email-to-purchase lookup via public API,
   * so this is only usable if we have purchase_facts stored from webhooks.
   * Returns null, callers should query purchase_facts directly.
   */
  async verifyPurchase(_emailOrId: string): Promise<Verification | null> {
    return null;
  }

  /**
   * Get recent purchases.
   * Payhip doesn't expose a general orders API, purchases come via webhooks.
   */
  async getRecentPurchases(_limit?: number): Promise<PurchaseRecord[]> {
    return [];
  }

  // ============================================================================
  // PAYHIP-SPECIFIC METHODS
  // ============================================================================

  /**
   * Verify a license key against all known product secret keys for a tenant.
   *
   * Scans each product key until a match is found. Payhip returns an empty body
   * when the key doesn't match a product, and `{ data: { ... } }` when it does.
   *
   * @param licenseKey - The license key submitted by the buyer
   * @param productKeys - List of { permalink, secretKey } for all tenant products
   */
  async verifyLicenseKey(
    licenseKey: string,
    productKeys: PayhipProductKey[]
  ): Promise<PayhipLicenseVerifyResult> {
    if (productKeys.length === 0) {
      return {
        valid: false,
        error: 'No product secret keys configured for this store. Contact the server owner.',
      };
    }

    for (const { permalink, secretKey } of productKeys) {
      try {
        const data = await this.client.verifyLicenseKey(licenseKey, secretKey);
        if (data) {
          return {
            valid: data.enabled,
            data,
            matchedProductPermalink: permalink,
            error: data.enabled ? undefined : 'License key is disabled',
          };
        }
      } catch (error) {
        if (error instanceof PayhipApiError) {
          // Non-fatal: this product key didn't match, try next
          continue;
        }
        throw error;
      }
    }

    return {
      valid: false,
      error: 'License key not found or does not belong to any configured product.',
    };
  }

  /**
   * Get evidence from a verified license key result.
   */
  getLicenseEvidence(licenseKey: string, data: PayhipLicenseVerifyData): PayhipEvidence {
    return normalizeLicenseToEvidence(licenseKey, data);
  }

  /**
   * Disable a license key (e.g., on refund or ToS violation).
   */
  async disableLicenseKey(
    licenseKey: string,
    productSecretKey: string
  ): Promise<PayhipLicenseVerifyData | null> {
    return this.client.disableLicenseKey(licenseKey, productSecretKey);
  }

  /**
   * Enable a previously disabled license key.
   */
  async enableLicenseKey(
    licenseKey: string,
    productSecretKey: string
  ): Promise<PayhipLicenseVerifyData | null> {
    return this.client.enableLicenseKey(licenseKey, productSecretKey);
  }

  /**
   * Get the underlying API client for direct access.
   */
  getClient(): PayhipApiClient {
    return this.client;
  }
}

/**
 * Resolves the display name of a Payhip product from its permalink.
 *
 * Uses the iframely metadata API to bypass Cloudflare bot protection on
 * payhip.com/b/{permalink}. Returns the product name alongside the permalink
 * so callers can pass both to `addProductForProvider`.
 *
 * @param permalink - The product permalink (e.g., "KZFw0")
 * @returns Object with `id` (the permalink) and `name` (display name, or undefined)
 */
export async function resolvePayhipProduct(
  permalink: string
): Promise<{ id: string; name: string | undefined }> {
  const client = new PayhipApiClient();
  const name = await client.fetchProductName(permalink);
  return { id: permalink, name: name ?? undefined };
}
