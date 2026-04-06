import type { Verification } from '@yucp/shared';
import type { ProviderAdapter, ProviderConfig, PurchaseRecord } from '../legacyAdapter';
import { LemonSqueezyApiClient } from './client';
import type {
  LemonSqueezyAdapterConfig,
  LemonSqueezyEvidence,
  LemonSqueezyLicenseKey,
  LemonSqueezyLicenseValidationResult,
  LemonSqueezyOrder,
  LemonSqueezyStore,
  LemonSqueezySubscription,
  LemonSqueezyVariant,
} from './types';
import {
  isLicenseKeyValid,
  isOrderValid,
  isSubscriptionActive,
  type LemonSqueezyWebhookCreateInput,
  normalizeLicenseKeyToEvidence,
  normalizeOrderToEvidence,
  normalizeSubscriptionToEvidence,
} from './types';

export class LemonSqueezyAdapter implements ProviderAdapter {
  readonly name = 'lemonsqueezy';

  private readonly client: LemonSqueezyApiClient;

  constructor(config: ProviderConfig & LemonSqueezyAdapterConfig) {
    if (!config.apiToken) {
      throw new Error('Lemon Squeezy API token is required');
    }

    this.client = new LemonSqueezyApiClient({
      apiToken: config.apiToken,
      apiBaseUrl: config.apiBaseUrl,
      licenseApiBaseUrl: config.licenseApiBaseUrl,
      timeout: config.timeout,
      maxRetries: config.maxRetries,
    });
  }

  async verifyPurchase(emailOrId: string): Promise<Verification | null> {
    if (!emailOrId.includes('@')) {
      return null;
    }

    const { orders } = await this.client.getOrders({ userEmail: emailOrId, perPage: 25 });
    const validOrders = orders.filter(isOrderValid);
    if (validOrders.length === 0) {
      return null;
    }

    const latest = validOrders.sort((a, b) => {
      return new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime();
    })[0];

    return {
      id: `lemonsqueezy-${latest.id}`,
      userId: emailOrId,
      provider: 'lemonsqueezy',
      status: 'verified',
      createdAt: new Date(latest.createdAt ?? Date.now()),
    };
  }

  async getRecentPurchases(limit = 50): Promise<PurchaseRecord[]> {
    const { orders } = await this.client.getOrders({ perPage: Math.min(limit, 100) });
    return orders
      .filter(isOrderValid)
      .slice(0, limit)
      .map((order) => ({
        buyerEmail: order.userEmail ?? undefined,
        productId: String(order.firstOrderItem?.variantId ?? order.firstOrderItem?.productId ?? ''),
        purchaseDate: new Date(order.createdAt ?? Date.now()),
      }));
  }

  async getStores(
    page = 1,
    perPage = 50
  ): Promise<{
    stores: LemonSqueezyStore[];
    pagination: {
      currentPage: number;
      nextPage: number | null;
      previousPage: number | null;
      perPage: number;
      total: number;
      totalPages: number;
    };
  }> {
    return this.client.getStores(page, perPage);
  }

  async getProducts(storeId: string) {
    return this.client.getAllProducts(storeId);
  }

  async getVariants(productId: string) {
    return this.client.getAllVariants(productId);
  }

  async getOrders(params?: {
    storeId?: string;
    userEmail?: string;
    page?: number;
    perPage?: number;
  }) {
    return this.client.getOrders(params);
  }

  async getSubscriptions(params?: {
    storeId?: string;
    userEmail?: string;
    page?: number;
    perPage?: number;
  }) {
    return this.client.getSubscriptions(params);
  }

  async getLicenseKeys(params?: { storeId?: string; page?: number; perPage?: number }) {
    return this.client.getLicenseKeys(params);
  }

  async createWebhook(input: LemonSqueezyWebhookCreateInput) {
    return this.client.createWebhook(input);
  }

  async validateLicense(licenseKey: string): Promise<LemonSqueezyLicenseValidationResult> {
    const response = await this.client.validateLicenseKey(licenseKey);
    if (!response.valid) {
      return {
        valid: false,
        error: response.error ?? 'License validation failed',
      };
    }

    const license: LemonSqueezyLicenseKey = {
      id: String(response.license_key?.id ?? response.meta?.order_item_id ?? licenseKey),
      storeId: response.meta?.store_id ? String(response.meta.store_id) : undefined,
      customerId: response.meta?.customer_id ? String(response.meta.customer_id) : undefined,
      orderId: response.meta?.order_id ? String(response.meta.order_id) : undefined,
      orderItemId: response.meta?.order_item_id ? String(response.meta.order_item_id) : undefined,
      productId: response.meta?.product_id ?? null,
      variantId: response.meta?.variant_id ?? null,
      userName: response.meta?.user_name ?? null,
      userEmail: response.meta?.user_email ?? null,
      key: response.license_key?.key ?? licenseKey,
      keyShort: null,
      activationLimit: response.license_key?.activation_limit ?? null,
      instancesCount: response.license_key?.instances_count ?? null,
      disabled: response.license_key?.disabled === true,
      status: response.license_key?.status ?? null,
      expiresAt: response.license_key?.expires_at ?? null,
      testMode: response.meta?.test_mode === true,
      createdAt: response.license_key?.created_at,
    };

    return {
      valid: isLicenseKeyValid(license),
      license,
      customerEmail: response.meta?.user_email,
      customerName: response.meta?.user_name,
      subscriptionId: response.meta?.subscription_id
        ? String(response.meta.subscription_id)
        : undefined,
    };
  }

  async getCustomerEvidence(email: string): Promise<LemonSqueezyEvidence[]> {
    const evidence: LemonSqueezyEvidence[] = [];

    const [{ orders }, { subscriptions }] = await Promise.all([
      this.client.getOrders({ userEmail: email, perPage: 25 }),
      this.client.getSubscriptions({ userEmail: email, perPage: 25 }),
    ]);

    for (const order of orders) {
      evidence.push(normalizeOrderToEvidence(order));
    }

    for (const subscription of subscriptions) {
      evidence.push(normalizeSubscriptionToEvidence(subscription));
    }

    return evidence;
  }

  getClient(): LemonSqueezyApiClient {
    return this.client;
  }
}

export {
  isLicenseKeyValid,
  isOrderValid,
  isSubscriptionActive,
  normalizeLicenseKeyToEvidence,
  normalizeOrderToEvidence,
  normalizeSubscriptionToEvidence,
};

export type {
  LemonSqueezyAdapterConfig,
  LemonSqueezyEvidence,
  LemonSqueezyLicenseKey,
  LemonSqueezyLicenseValidationResult,
  LemonSqueezyOrder,
  LemonSqueezyStore,
  LemonSqueezySubscription,
  LemonSqueezyVariant,
};
export * from './client';
export * from './types';
