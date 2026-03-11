import type {
  LemonSqueezyAdapterConfig,
  LemonSqueezyApiErrorResponse,
  LemonSqueezyLicenseKey,
  LemonSqueezyLicenseValidationResponse,
  LemonSqueezyListResponse,
  LemonSqueezyOrder,
  LemonSqueezyPagination,
  LemonSqueezyProduct,
  LemonSqueezyStore,
  LemonSqueezySubscription,
  LemonSqueezyVariant,
  LemonSqueezyWebhook,
  LemonSqueezyWebhookCreateInput,
} from './types';
import { LemonSqueezyApiError, LemonSqueezyRateLimitError } from './types';

const DEFAULT_API_BASE_URL = 'https://api.lemonsqueezy.com/v1';
const DEFAULT_LICENSE_API_BASE_URL = 'https://api.lemonsqueezy.com/v1/licenses';
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_PAGE_SIZE = 50;

type QueryValue = string | number | boolean | undefined | null;

interface JsonApiResource<TAttributes extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  type: string;
  attributes: TAttributes;
  relationships?: Record<string, unknown>;
}

export class LemonSqueezyApiClient {
  private readonly baseUrl: string;
  private readonly licenseApiBaseUrl: string;
  private readonly apiToken: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(config: LemonSqueezyAdapterConfig) {
    if (!config.apiToken) {
      throw new Error('Lemon Squeezy API token is required');
    }

    this.apiToken = config.apiToken;
    this.baseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.licenseApiBaseUrl = config.licenseApiBaseUrl ?? DEFAULT_LICENSE_API_BASE_URL;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  static fromEnv(): LemonSqueezyApiClient {
    const apiToken = process.env.LEMONSQUEEZY_API_TOKEN;
    if (!apiToken) {
      throw new Error('LEMONSQUEEZY_API_TOKEN environment variable is required');
    }

    return new LemonSqueezyApiClient({
      apiToken,
      apiBaseUrl: process.env.LEMONSQUEEZY_API_BASE_URL,
      licenseApiBaseUrl: process.env.LEMONSQUEEZY_LICENSE_API_BASE_URL,
      timeout: process.env.LEMONSQUEEZY_API_TIMEOUT
        ? Number.parseInt(process.env.LEMONSQUEEZY_API_TIMEOUT, 10)
        : undefined,
    });
  }

  private async request<T>(
    method: string,
    path: string,
    query?: Record<string, QueryValue>,
    body?: unknown,
    retryCount = 0
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 429) {
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '1', 10);
        if (retryCount < this.maxRetries) {
          await this.sleep(retryAfter * 1000 * (retryCount + 1));
          return this.request<T>(method, path, query, body, retryCount + 1);
        }
        throw new LemonSqueezyRateLimitError(
          'Rate limit exceeded after maximum retries',
          retryAfter
        );
      }

      if (!response.ok) {
        const error = (await this.safeParseJson(response)) as LemonSqueezyApiErrorResponse | null;
        const message =
          error?.errors?.[0]?.detail ?? error?.errors?.[0]?.title ?? `HTTP ${response.status}`;
        throw new LemonSqueezyApiError(message, response.status, error);
      }

      if (response.status === 204) return undefined as unknown as T;
      return (await response.json()) as T;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof LemonSqueezyApiError || error instanceof LemonSqueezyRateLimitError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new LemonSqueezyApiError('Request timeout', 408);
      }
      throw new LemonSqueezyApiError(error instanceof Error ? error.message : 'Unknown error', 0);
    }
  }

  private async licenseRequest<T>(body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.licenseApiBaseUrl}/validate`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await this.safeParseJson(response);
        throw new LemonSqueezyApiError(`HTTP ${response.status}`, response.status, error);
      }

      return (await response.json()) as T;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof LemonSqueezyApiError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new LemonSqueezyApiError('Request timeout', 408);
      }
      throw new LemonSqueezyApiError(error instanceof Error ? error.message : 'Unknown error', 0);
    }
  }

  private async safeParseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private mapPagination<T>(response: LemonSqueezyListResponse<T>): LemonSqueezyPagination {
    const page = response.meta?.page;
    const currentPage = page?.currentPage ?? 1;
    const totalPages = page?.lastPage ?? 1;

    return {
      currentPage,
      nextPage: currentPage < totalPages ? currentPage + 1 : null,
      previousPage: currentPage > 1 ? currentPage - 1 : null,
      perPage: page?.perPage ?? DEFAULT_PAGE_SIZE,
      total: page?.total ?? response.data.length,
      totalPages,
    };
  }

  private mapStore(
    resource: JsonApiResource<{
      name?: string;
      slug?: string;
      domain?: string | null;
      status?: string | null;
      url?: string | null;
      test_mode?: boolean;
      created_at?: string;
      updated_at?: string;
    }>
  ): LemonSqueezyStore {
    return {
      id: resource.id,
      name: resource.attributes.name ?? resource.id,
      slug: resource.attributes.slug ?? resource.id,
      domain: resource.attributes.domain ?? null,
      status: resource.attributes.status ?? null,
      url: resource.attributes.url ?? null,
      testMode: resource.attributes.test_mode ?? false,
      createdAt: resource.attributes.created_at,
      updatedAt: resource.attributes.updated_at,
    };
  }

  private mapProduct(
    resource: JsonApiResource<{
      store_id?: number;
      name?: string;
      slug?: string | null;
      status?: string | null;
      description?: string | null;
      url?: string | null;
      test_mode?: boolean;
      created_at?: string;
      updated_at?: string;
    }>
  ): LemonSqueezyProduct {
    return {
      id: resource.id,
      storeId: resource.attributes.store_id ? String(resource.attributes.store_id) : undefined,
      name: resource.attributes.name ?? resource.id,
      slug: resource.attributes.slug ?? null,
      status: resource.attributes.status ?? null,
      description: resource.attributes.description ?? null,
      url: resource.attributes.url ?? null,
      testMode: resource.attributes.test_mode ?? false,
      createdAt: resource.attributes.created_at,
      updatedAt: resource.attributes.updated_at,
    };
  }

  private mapVariant(
    resource: JsonApiResource<{
      product_id?: number;
      name?: string;
      slug?: string | null;
      description?: string | null;
      price?: number | null;
      status?: string | null;
      has_license_keys?: boolean;
      license_length_value?: number | null;
      license_length_unit?: string | null;
      is_subscription?: boolean;
      test_mode?: boolean;
      created_at?: string;
      updated_at?: string;
    }>
  ): LemonSqueezyVariant {
    return {
      id: resource.id,
      productId: resource.attributes.product_id
        ? String(resource.attributes.product_id)
        : undefined,
      name: resource.attributes.name ?? resource.id,
      slug: resource.attributes.slug ?? null,
      description: resource.attributes.description ?? null,
      price: resource.attributes.price ?? null,
      status: resource.attributes.status ?? null,
      hasLicenseKeys: resource.attributes.has_license_keys ?? false,
      licenseLengthValue: resource.attributes.license_length_value ?? null,
      licenseLengthUnit: resource.attributes.license_length_unit ?? null,
      isSubscription: resource.attributes.is_subscription ?? false,
      testMode: resource.attributes.test_mode ?? false,
      createdAt: resource.attributes.created_at,
      updatedAt: resource.attributes.updated_at,
    };
  }

  private mapOrder(resource: JsonApiResource<Record<string, unknown>>): LemonSqueezyOrder {
    const attributes = resource.attributes;
    return {
      id: resource.id,
      storeId: attributes.store_id ? String(attributes.store_id) : undefined,
      customerId: attributes.customer_id ? String(attributes.customer_id) : undefined,
      identifier: typeof attributes.identifier === 'string' ? attributes.identifier : null,
      orderNumber: typeof attributes.order_number === 'number' ? attributes.order_number : null,
      userName: typeof attributes.user_name === 'string' ? attributes.user_name : null,
      userEmail: typeof attributes.user_email === 'string' ? attributes.user_email : null,
      currency: typeof attributes.currency === 'string' ? attributes.currency : null,
      currencyRate: typeof attributes.currency_rate === 'string' ? attributes.currency_rate : null,
      subtotal: typeof attributes.subtotal === 'number' ? attributes.subtotal : null,
      total: typeof attributes.total === 'number' ? attributes.total : null,
      tax: typeof attributes.tax === 'number' ? attributes.tax : null,
      status: typeof attributes.status === 'string' ? attributes.status : null,
      refunded: attributes.refunded === true,
      refundedAt: typeof attributes.refunded_at === 'string' ? attributes.refunded_at : null,
      testMode: attributes.test_mode === true,
      firstOrderItem:
        typeof attributes.first_order_item === 'object' && attributes.first_order_item
          ? (attributes.first_order_item as LemonSqueezyOrder['firstOrderItem'])
          : undefined,
      urls:
        typeof attributes.urls === 'object' && attributes.urls
          ? (attributes.urls as Record<string, unknown>)
          : undefined,
      createdAt: typeof attributes.created_at === 'string' ? attributes.created_at : undefined,
      updatedAt: typeof attributes.updated_at === 'string' ? attributes.updated_at : undefined,
    };
  }

  private mapSubscription(
    resource: JsonApiResource<Record<string, unknown>>
  ): LemonSqueezySubscription {
    const attributes = resource.attributes;
    return {
      id: resource.id,
      storeId: attributes.store_id ? String(attributes.store_id) : undefined,
      customerId: attributes.customer_id ? String(attributes.customer_id) : undefined,
      orderId: attributes.order_id ? String(attributes.order_id) : undefined,
      orderItemId: attributes.order_item_id ? String(attributes.order_item_id) : undefined,
      productId: typeof attributes.product_id === 'number' ? attributes.product_id : null,
      variantId: typeof attributes.variant_id === 'number' ? attributes.variant_id : null,
      productName: typeof attributes.product_name === 'string' ? attributes.product_name : null,
      variantName: typeof attributes.variant_name === 'string' ? attributes.variant_name : null,
      userName: typeof attributes.user_name === 'string' ? attributes.user_name : null,
      userEmail: typeof attributes.user_email === 'string' ? attributes.user_email : null,
      status: typeof attributes.status === 'string' ? attributes.status : null,
      statusFormatted:
        typeof attributes.status_formatted === 'string' ? attributes.status_formatted : null,
      cardBrand: typeof attributes.card_brand === 'string' ? attributes.card_brand : null,
      cardLastFour:
        typeof attributes.card_last_four === 'string' ? attributes.card_last_four : null,
      pause: attributes.pause,
      cancelled: attributes.cancelled === true,
      trialEndsAt: typeof attributes.trial_ends_at === 'string' ? attributes.trial_ends_at : null,
      billingAnchor:
        typeof attributes.billing_anchor === 'number' ? attributes.billing_anchor : null,
      firstSubscriptionItem:
        typeof attributes.first_subscription_item === 'object' && attributes.first_subscription_item
          ? (attributes.first_subscription_item as LemonSqueezySubscription['firstSubscriptionItem'])
          : undefined,
      renewsAt: typeof attributes.renews_at === 'string' ? attributes.renews_at : null,
      endsAt: typeof attributes.ends_at === 'string' ? attributes.ends_at : null,
      testMode: attributes.test_mode === true,
      createdAt: typeof attributes.created_at === 'string' ? attributes.created_at : undefined,
      updatedAt: typeof attributes.updated_at === 'string' ? attributes.updated_at : undefined,
    };
  }

  private mapLicenseKey(
    resource: JsonApiResource<Record<string, unknown>>
  ): LemonSqueezyLicenseKey {
    const attributes = resource.attributes;
    return {
      id: resource.id,
      storeId: attributes.store_id ? String(attributes.store_id) : undefined,
      customerId: attributes.customer_id ? String(attributes.customer_id) : undefined,
      orderId: attributes.order_id ? String(attributes.order_id) : undefined,
      orderItemId: attributes.order_item_id ? String(attributes.order_item_id) : undefined,
      productId: typeof attributes.product_id === 'number' ? attributes.product_id : null,
      variantId: typeof attributes.variant_id === 'number' ? attributes.variant_id : null,
      userName: typeof attributes.user_name === 'string' ? attributes.user_name : null,
      userEmail: typeof attributes.user_email === 'string' ? attributes.user_email : null,
      key: typeof attributes.key === 'string' ? attributes.key : null,
      keyShort: typeof attributes.key_short === 'string' ? attributes.key_short : null,
      activationLimit:
        typeof attributes.activation_limit === 'number' ? attributes.activation_limit : null,
      instancesCount:
        typeof attributes.instances_count === 'number' ? attributes.instances_count : null,
      disabled: attributes.disabled === true,
      status: typeof attributes.status === 'string' ? attributes.status : null,
      expiresAt: typeof attributes.expires_at === 'string' ? attributes.expires_at : null,
      testMode: attributes.test_mode === true,
      createdAt: typeof attributes.created_at === 'string' ? attributes.created_at : undefined,
      updatedAt: typeof attributes.updated_at === 'string' ? attributes.updated_at : undefined,
    };
  }

  private mapWebhook(
    resource: JsonApiResource<{
      store_id?: number;
      url?: string;
      events?: string[];
      secret?: string | null;
      test_mode?: boolean;
      created_at?: string;
      updated_at?: string;
    }>
  ): LemonSqueezyWebhook {
    return {
      id: resource.id,
      storeId: resource.attributes.store_id ? String(resource.attributes.store_id) : undefined,
      url: resource.attributes.url ?? '',
      events: resource.attributes.events ?? [],
      secret: resource.attributes.secret ?? null,
      testMode: resource.attributes.test_mode ?? false,
      createdAt: resource.attributes.created_at,
      updatedAt: resource.attributes.updated_at,
    };
  }

  async getStores(
    page = 1,
    perPage = DEFAULT_PAGE_SIZE
  ): Promise<{
    stores: LemonSqueezyStore[];
    pagination: LemonSqueezyPagination;
  }> {
    const response = await this.request<
      LemonSqueezyListResponse<
        JsonApiResource<{
          name?: string;
          slug?: string;
          domain?: string | null;
          status?: string | null;
          url?: string | null;
          test_mode?: boolean;
          created_at?: string;
          updated_at?: string;
        }>
      >
    >('GET', '/stores', {
      'page[number]': page,
      'page[size]': perPage,
    });

    return {
      stores: response.data.map((resource) => this.mapStore(resource)),
      pagination: this.mapPagination(response),
    };
  }

  async getProducts(params?: { storeId?: string; page?: number; perPage?: number }): Promise<{
    products: LemonSqueezyProduct[];
    pagination: LemonSqueezyPagination;
  }> {
    const response = await this.request<
      LemonSqueezyListResponse<
        JsonApiResource<{
          store_id?: number;
          name?: string;
          slug?: string | null;
          status?: string | null;
          description?: string | null;
          url?: string | null;
          test_mode?: boolean;
          created_at?: string;
          updated_at?: string;
        }>
      >
    >('GET', '/products', {
      'filter[store_id]': params?.storeId,
      'page[number]': params?.page ?? 1,
      'page[size]': params?.perPage ?? DEFAULT_PAGE_SIZE,
    });

    return {
      products: response.data.map((resource) => this.mapProduct(resource)),
      pagination: this.mapPagination(response),
    };
  }

  async getVariants(params?: { productId?: string; page?: number; perPage?: number }): Promise<{
    variants: LemonSqueezyVariant[];
    pagination: LemonSqueezyPagination;
  }> {
    const response = await this.request<
      LemonSqueezyListResponse<
        JsonApiResource<{
          product_id?: number;
          name?: string;
          slug?: string | null;
          description?: string | null;
          price?: number | null;
          status?: string | null;
          has_license_keys?: boolean;
          license_length_value?: number | null;
          license_length_unit?: string | null;
          is_subscription?: boolean;
          test_mode?: boolean;
          created_at?: string;
          updated_at?: string;
        }>
      >
    >('GET', '/variants', {
      'filter[product_id]': params?.productId,
      'page[number]': params?.page ?? 1,
      'page[size]': params?.perPage ?? DEFAULT_PAGE_SIZE,
    });

    return {
      variants: response.data.map((resource) => this.mapVariant(resource)),
      pagination: this.mapPagination(response),
    };
  }

  async getOrders(params?: {
    storeId?: string;
    userEmail?: string;
    page?: number;
    perPage?: number;
  }): Promise<{ orders: LemonSqueezyOrder[]; pagination: LemonSqueezyPagination }> {
    const response = await this.request<LemonSqueezyListResponse<JsonApiResource>>(
      'GET',
      '/orders',
      {
        'filter[store_id]': params?.storeId,
        'filter[user_email]': params?.userEmail,
        'page[number]': params?.page ?? 1,
        'page[size]': params?.perPage ?? DEFAULT_PAGE_SIZE,
      }
    );

    return {
      orders: response.data.map((resource) => this.mapOrder(resource as JsonApiResource)),
      pagination: this.mapPagination(response),
    };
  }

  async getSubscriptions(params?: {
    storeId?: string;
    userEmail?: string;
    page?: number;
    perPage?: number;
  }): Promise<{ subscriptions: LemonSqueezySubscription[]; pagination: LemonSqueezyPagination }> {
    const response = await this.request<LemonSqueezyListResponse<JsonApiResource>>(
      'GET',
      '/subscriptions',
      {
        'filter[store_id]': params?.storeId,
        'filter[user_email]': params?.userEmail,
        'page[number]': params?.page ?? 1,
        'page[size]': params?.perPage ?? DEFAULT_PAGE_SIZE,
      }
    );

    return {
      subscriptions: response.data.map((resource) =>
        this.mapSubscription(resource as JsonApiResource)
      ),
      pagination: this.mapPagination(response),
    };
  }

  async getLicenseKeys(params?: { storeId?: string; page?: number; perPage?: number }): Promise<{
    licenseKeys: LemonSqueezyLicenseKey[];
    pagination: LemonSqueezyPagination;
  }> {
    const response = await this.request<LemonSqueezyListResponse<JsonApiResource>>(
      'GET',
      '/license-keys',
      {
        'filter[store_id]': params?.storeId,
        'page[number]': params?.page ?? 1,
        'page[size]': params?.perPage ?? DEFAULT_PAGE_SIZE,
      }
    );

    return {
      licenseKeys: response.data.map((resource) => this.mapLicenseKey(resource as JsonApiResource)),
      pagination: this.mapPagination(response),
    };
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request<null>('DELETE', `/webhooks/${webhookId}`);
  }

  async updateWebhook(
    webhookId: string,
    updates: Partial<{ url: string; events: string[]; secret: string }>
  ): Promise<LemonSqueezyWebhook> {
    const response = await this.request<{
      data: JsonApiResource<{
        store_id?: number;
        url?: string;
        events?: string[];
        secret?: string | null;
        test_mode?: boolean;
        created_at?: string;
        updated_at?: string;
      }>;
    }>('PATCH', `/webhooks/${webhookId}`, undefined, {
      data: {
        type: 'webhooks',
        id: webhookId,
        attributes: {
          ...(updates.url !== undefined ? { url: updates.url } : {}),
          ...(updates.events !== undefined ? { events: updates.events } : {}),
          ...(updates.secret !== undefined ? { secret: updates.secret } : {}),
        },
      },
    });
    return this.mapWebhook(response.data);
  }

  async createWebhook(input: LemonSqueezyWebhookCreateInput): Promise<LemonSqueezyWebhook> {
    const response = await this.request<{
      data: JsonApiResource<{
        store_id?: number;
        url?: string;
        events?: string[];
        secret?: string | null;
        test_mode?: boolean;
        created_at?: string;
        updated_at?: string;
      }>;
    }>('POST', '/webhooks', undefined, {
      data: {
        type: 'webhooks',
        attributes: {
          url: input.url,
          events: input.events,
          secret: input.secret,
          test_mode: input.testMode ?? false,
        },
        relationships: {
          store: {
            data: {
              type: 'stores',
              id: input.storeId,
            },
          },
        },
      },
    });

    return this.mapWebhook(response.data);
  }

  async validateLicenseKey(licenseKey: string): Promise<LemonSqueezyLicenseValidationResponse> {
    return this.licenseRequest<LemonSqueezyLicenseValidationResponse>({
      license_key: licenseKey,
    });
  }

  async getAllProducts(storeId: string): Promise<LemonSqueezyProduct[]> {
    const products: LemonSqueezyProduct[] = [];
    let page = 1;
    while (true) {
      const response = await this.getProducts({ storeId, page });
      products.push(...response.products);
      if (!response.pagination.nextPage) break;
      page = response.pagination.nextPage;
    }
    return products;
  }

  async getAllVariants(productId: string): Promise<LemonSqueezyVariant[]> {
    const variants: LemonSqueezyVariant[] = [];
    let page = 1;
    while (true) {
      const response = await this.getVariants({ productId, page });
      variants.push(...response.variants);
      if (!response.pagination.nextPage) break;
      page = response.pagination.nextPage;
    }
    return variants;
  }
}

export * from './types';
