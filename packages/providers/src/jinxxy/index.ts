/**
 * Jinxxy Provider Adapter
 *
 * Implements the ProviderAdapter interface for Jinxxy Creator API integration.
 * Provides license and purchase verification through API key authentication.
 *
 * Usage:
 * ```ts
 * const adapter = new JinxxyAdapter({ apiKey: 'your-api-key' });
 * const result = await adapter.verifyLicense('LICENSE-KEY-123');
 * const purchases = await adapter.verifyPurchase('buyer@example.com');
 * ```
 */

import type { Verification } from '@yucp/shared';
import type { ProviderAdapter, ProviderConfig, PurchaseRecord } from '../legacyAdapter';
import { JinxxyApiClient } from './client';
import type {
  JinxxyAdapterConfig,
  JinxxyCustomer,
  JinxxyEvidence,
  JinxxyLicense,
  JinxxyOrder,
  LicenseVerificationResult,
  PaginationParams,
  PurchaseVerificationResult,
} from './types';
import {
  isLicenseValid,
  isOrderValid,
  JinxxyApiError,
  normalizeLicenseToEvidence,
  normalizeOrderToEvidence,
} from './types';

/**
 * Jinxxy provider adapter implementing ProviderAdapter interface
 */
export class JinxxyAdapter implements ProviderAdapter {
  readonly name = 'jinxxy';

  private readonly client: JinxxyApiClient;

  constructor(config: ProviderConfig & JinxxyAdapterConfig) {
    if (!config.apiKey) {
      throw new Error('Jinxxy API key is required');
    }

    this.client = new JinxxyApiClient({
      apiKey: config.apiKey,
      apiBaseUrl: config.apiBaseUrl,
      timeout: config.timeout,
      maxRetries: config.maxRetries,
    });
  }

  // ============================================================================
  // PROVIDER ADAPTER INTERFACE
  // ============================================================================

  /**
   * Verify a purchase by email address or Discord ID.
   * This method implements the ProviderAdapter interface.
   *
   * @param emailOrId - Email address or Discord ID to verify
   */
  async verifyPurchase(emailOrId: string): Promise<Verification | null> {
    try {
      // Determine if this is an email or Discord ID
      const isEmail = emailOrId.includes('@');

      let orders: JinxxyOrder[];
      if (isEmail) {
        orders = await this.client.getOrdersByEmail(emailOrId);
      } else {
        orders = await this.client.getOrdersByDiscordId(emailOrId);
      }

      // Filter to valid (completed, not refunded) orders
      const validOrders = orders.filter(isOrderValid);

      if (validOrders.length === 0) {
        return null;
      }

      // Return verification for the most recent valid order
      const latestOrder = validOrders.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )[0];

      return {
        id: `jinxxy-${latestOrder.id}`,
        userId: emailOrId,
        provider: 'jinxxy',
        status: 'verified',
        createdAt: new Date(latestOrder.created_at),
      };
    } catch (error) {
      if (error instanceof JinxxyApiError) {
        console.error(`Jinxxy API error: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Get recent purchases for the authenticated creator.
   * This method implements the ProviderAdapter interface.
   *
   * @param limit - Maximum number of purchases to return
   */
  async getRecentPurchases(limit = 50): Promise<PurchaseRecord[]> {
    const { orders } = await this.client.getOrders({
      page: 1,
      per_page: Math.min(limit, 100),
    });

    return orders
      .filter(isOrderValid)
      .slice(0, limit)
      .map((order) => ({
        buyerEmail: order.email,
        buyerDiscordId: order.discord_id,
        productId: order.product_id,
        purchaseDate: new Date(order.created_at),
        licenseKey: order.license_id,
      }));
  }

  // ============================================================================
  // JINXXY-SPECIFIC METHODS
  // ============================================================================

  /**
   * Verify a license by key.
   *
   * @param licenseKey - The license key to verify
   */
  async verifyLicense(licenseKey: string): Promise<LicenseVerificationResult> {
    try {
      const result = await this.client.verifyLicenseByKey(licenseKey);

      return {
        valid: result.valid,
        license: result.license ?? undefined,
        error: result.error,
      };
    } catch (error) {
      if (error instanceof JinxxyApiError) {
        return {
          valid: false,
          license: undefined,
          error: error.message,
        };
      }
      return {
        valid: false,
        license: undefined,
        error: 'Unknown error',
      };
    }
  }

  /**
   * Get all evidence (licenses and orders) for a customer.
   *
   * @param customerId - The Jinxxy customer ID
   */
  async getCustomerEvidence(customerId: string): Promise<JinxxyEvidence[]> {
    const evidence: JinxxyEvidence[] = [];

    // Get customer info
    const customer = await this.client.getCustomer(customerId);

    // Get licenses
    const licenses = await this.client.getAllLicenses({ customer_id: customerId });
    for (const license of licenses) {
      evidence.push(normalizeLicenseToEvidence(license, customer ?? undefined));
    }

    // Get orders
    const orders = await this.client.getAllOrders({ customer_id: customerId });
    for (const order of orders) {
      evidence.push(normalizeOrderToEvidence(order));
    }

    return evidence;
  }

  /**
   * Get all licenses with pagination.
   *
   * @param params - Pagination and filter parameters
   */
  async getLicenses(
    params?: PaginationParams & {
      product_id?: string;
      customer_id?: string;
      status?: string;
    }
  ): Promise<{
    licenses: JinxxyLicense[];
    evidence: JinxxyEvidence[];
    pagination: {
      page: number;
      per_page: number;
      total: number;
      has_next: boolean;
    };
  }> {
    const { licenses, pagination } = await this.client.getLicenses(params);

    // Get customer info for each unique customer
    const customerCache = new Map<string, JinxxyCustomer | null>();
    const evidence: JinxxyEvidence[] = [];

    for (const license of licenses) {
      let customer: JinxxyCustomer | null = null;
      if (license.customer_id) {
        if (!customerCache.has(license.customer_id)) {
          customer = await this.client.getCustomer(license.customer_id);
          customerCache.set(license.customer_id, customer);
        } else {
          customer = customerCache.get(license.customer_id) ?? null;
        }
      }
      evidence.push(normalizeLicenseToEvidence(license, customer ?? undefined));
    }

    return {
      licenses,
      evidence,
      pagination: {
        page: pagination.page,
        per_page: pagination.per_page,
        total: pagination.total,
        has_next: pagination.has_next,
      },
    };
  }

  /**
   * Get all orders with pagination.
   *
   * @param params - Pagination and filter parameters
   */
  async getOrders(
    params?: PaginationParams & {
      product_id?: string;
      customer_id?: string;
      status?: string;
      email?: string;
    }
  ): Promise<{
    orders: JinxxyOrder[];
    evidence: JinxxyEvidence[];
    pagination: {
      page: number;
      per_page: number;
      total: number;
      has_next: boolean;
    };
  }> {
    const { orders, pagination } = await this.client.getOrders(params);

    const evidence = orders.map(normalizeOrderToEvidence);

    return {
      orders,
      evidence,
      pagination: {
        page: pagination.page,
        per_page: pagination.per_page,
        total: pagination.total,
        has_next: pagination.has_next,
      },
    };
  }

  /**
   * Verify a purchase by order ID.
   *
   * @param orderId - The Jinxxy order ID
   */
  async verifyOrderById(orderId: string): Promise<PurchaseVerificationResult> {
    try {
      const order = await this.client.getOrder(orderId);

      if (!order) {
        return {
          found: false,
          error: 'Order not found',
        };
      }

      // Get associated license if available
      let license: JinxxyLicense | undefined;
      if (order.license_id) {
        const foundLicense = await this.client.getLicense(order.license_id);
        license = foundLicense ?? undefined;
      }

      return {
        found: true,
        order,
        license,
      };
    } catch (error) {
      if (error instanceof JinxxyApiError) {
        return {
          found: false,
          error: error.message,
        };
      }
      return {
        found: false,
        error: 'Unknown error',
      };
    }
  }

  /**
   * Check if a license is still valid.
   *
   * @param licenseId - The Jinxxy license ID
   */
  async checkLicenseStatus(licenseId: string): Promise<{
    found: boolean;
    valid: boolean;
    license?: JinxxyLicense;
    error?: string;
  }> {
    try {
      const license = await this.client.getLicense(licenseId);

      if (!license) {
        return {
          found: false,
          valid: false,
          error: 'License not found',
        };
      }

      return {
        found: true,
        valid: isLicenseValid(license),
        license,
      };
    } catch (error) {
      if (error instanceof JinxxyApiError) {
        return {
          found: false,
          valid: false,
          error: error.message,
        };
      }
      return {
        found: false,
        valid: false,
        error: 'Unknown error',
      };
    }
  }

  /**
   * Get the API client for direct access.
   */
  getClient(): JinxxyApiClient {
    return this.client;
  }
}

export * from './client';
// Re-export types and utilities
export * from './types';
