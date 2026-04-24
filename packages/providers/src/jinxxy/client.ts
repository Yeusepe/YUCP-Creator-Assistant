/**
 * Jinxxy Creator API Client
 *
 * HTTP client for Jinxxy Creator API with x-api-key authentication.
 * Handles pagination, rate limiting, and error handling.
 *
 * Usage:
 * ```ts
 * const client = new JinxxyApiClient({ apiKey: 'your-api-key' });
 * const licenses = await client.getLicenses();
 * ```
 */

import { withProviderRequestSpan } from '../core/observability';
import type {
  JinxxyActivationsResponse,
  JinxxyAdapterConfig,
  JinxxyApiErrorResponse,
  JinxxyCustomer,
  JinxxyCustomerResponse,
  JinxxyCustomersResponse,
  JinxxyLicense,
  JinxxyLicenseListResponse,
  JinxxyLicenseListResult,
  JinxxyLicenseRaw,
  JinxxyLicenseResponse,
  JinxxyLicensesResponse,
  JinxxyOrder,
  JinxxyOrderResponse,
  JinxxyOrdersResponse,
  JinxxyPagination,
  JinxxyProduct,
  JinxxyProductResponse,
  JinxxyProductsResponse,
  JinxxyUser,
  JinxxyUserResponse,
  PaginationParams,
} from './types';
import { JinxxyApiError, JinxxyRateLimitError } from './types';

/**
 * Default API base URL
 */
const DEFAULT_API_BASE_URL = 'https://api.creators.jinxxy.com/v1';

/**
 * Default request timeout in milliseconds
 */
const DEFAULT_TIMEOUT = 30000;

/**
 * Default maximum retries for rate-limited requests
 */
const DEFAULT_MAX_RETRIES = 3;

/**
 * Default page size for paginated requests
 */
const DEFAULT_PAGE_SIZE = 50;

/**
 * Jinxxy Creator API Client
 */
export class JinxxyApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(config: JinxxyAdapterConfig) {
    this.baseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /**
   * Make an authenticated request to the Jinxxy API
   */
  private async request<T>(
    method: string,
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
    retryCount = 0
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.append(key, String(value));
        }
      }
    }

    return withProviderRequestSpan(
      'jinxxy',
      method,
      path,
      {
        'server.address': url.host,
        retryCount,
        hasBody: body !== undefined,
      },
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
          const response = await fetch(url.toString(), {
            method,
            headers: {
              'x-api-key': this.apiKey,
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (response.status === 429) {
            const retryAfter = response.headers.get('retry-after');
            const retryAfterMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 1000;

            if (retryCount < this.maxRetries) {
              await this.sleep(retryAfterMs * (retryCount + 1));
              return this.request<T>(method, path, params, body, retryCount + 1);
            }

            throw new JinxxyRateLimitError(
              'Rate limit exceeded after maximum retries',
              retryAfterMs
            );
          }

          if (!response.ok) {
            const errorBody = (await this.safeParseJson(response)) as JinxxyApiErrorResponse | null;
            const errorMessage =
              errorBody?.error ?? errorBody?.message ?? `HTTP ${response.status}`;
            const errorCode = errorBody?.error;

            throw new JinxxyApiError(errorMessage, response.status, errorCode, errorBody?.details);
          }

          const data = await response.json();
          return data as T;
        } catch (error) {
          clearTimeout(timeoutId);

          if (error instanceof JinxxyApiError || error instanceof JinxxyRateLimitError) {
            throw error;
          }

          if (error instanceof Error) {
            if (error.name === 'AbortError') {
              throw new JinxxyApiError('Request timeout', 408, 'timeout');
            }
            throw new JinxxyApiError(error.message, 0, 'network_error');
          }

          throw new JinxxyApiError('Unknown error', 0, 'unknown');
        }
      }
    );
  }

  /**
   * Safely parse JSON response
   */
  private async safeParseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  /**
   * Sleep utility for retries
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ============================================================================
  // USER ENDPOINTS
  // ============================================================================

  /**
   * Get the authenticated user's profile.
   * Jinxxy API returns the user object directly (AuthUser), not wrapped in { success, user }.
   * See jinx-master src/http/jinxxy/dto.rs AuthUser and mod.rs get_own_user.
   */
  async getCurrentUser(): Promise<JinxxyUser> {
    const data = await this.request<JinxxyUserResponse | JinxxyUser>('GET', '/me');

    // Wrapped format: { success, user }
    if ('success' in data && data.success && data.user) {
      return data.user;
    }

    // Direct format: AuthUser with id, username/name (Jinxxy API actual response)
    if ('id' in data && typeof data.id === 'string') {
      const raw = data as { id: string; username?: string; name?: string; email?: string };
      return {
        id: raw.id,
        username: raw.username ?? raw.name ?? raw.id,
        email: raw.email,
        created_at: '',
      };
    }

    const err = data as JinxxyUserResponse;
    throw new JinxxyApiError(
      err.error ?? err.message ?? 'Failed to get user profile',
      401,
      'unauthorized'
    );
  }

  // ============================================================================
  // PRODUCT ENDPOINTS
  // ============================================================================

  /**
   * List all products.
   * Jinxxy API uses `limit` and `page`, and returns products in `results` (not `products`).
   */
  async getProducts(params?: PaginationParams): Promise<{
    products: JinxxyProduct[];
    pagination: JinxxyPagination;
  }> {
    const response = await this.request<JinxxyProductsResponse>('GET', '/products', {
      page: params?.page ?? 1,
      limit: params?.per_page ?? DEFAULT_PAGE_SIZE,
    });

    const products = response.results ?? response.products ?? [];
    const hasNext =
      response.page_count != null
        ? (response.page ?? 1) < response.page_count
        : (response.pagination?.has_next ?? false);

    return {
      products,
      pagination: response.pagination ?? {
        ...this.getDefaultPagination(),
        has_next: hasNext,
      },
    };
  }

  /**
   * Get a specific product by ID
   */
  async getProduct(productId: string): Promise<JinxxyProduct | null> {
    try {
      /**
       * Jinxxy product docs:
       * - https://api.creators.jinxxy.com/v1/docs#tag/products/GET/products/{id}
       * - https://api.creators.jinxxy.com/v1/openapi.json
       * The endpoint returns the product object directly, including `versions[]`.
       */
      const data = await this.request<JinxxyProductResponse | JinxxyProduct>(
        'GET',
        `/products/${productId}`
      );

      const product = (data as JinxxyProductResponse).product ?? (data as JinxxyProduct);
      return product?.id ? product : null;
    } catch (error) {
      if (error instanceof JinxxyApiError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  // ============================================================================
  // CUSTOMER ENDPOINTS
  // ============================================================================

  /**
   * List all customers
   */
  async getCustomers(params?: PaginationParams): Promise<{
    customers: JinxxyCustomer[];
    pagination: JinxxyPagination;
  }> {
    const response = await this.request<JinxxyCustomersResponse>('GET', '/customers', {
      page: params?.page ?? 1,
      per_page: params?.per_page ?? DEFAULT_PAGE_SIZE,
    });

    return {
      customers: response.customers ?? [],
      pagination: response.pagination ?? this.getDefaultPagination(),
    };
  }

  /**
   * Get a specific customer by ID
   */
  async getCustomer(customerId: string): Promise<JinxxyCustomer | null> {
    try {
      const response = await this.request<JinxxyCustomerResponse>(
        'GET',
        `/customers/${customerId}`
      );

      return response.customer ?? null;
    } catch (error) {
      if (error instanceof JinxxyApiError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  // ============================================================================
  // LICENSE ENDPOINTS
  // ============================================================================

  /**
   * List all licenses with optional filtering
   */
  async getLicenses(
    params?: PaginationParams & {
      product_id?: string;
      customer_id?: string;
      status?: string;
      key?: string;
      short_key?: string;
    }
  ): Promise<{
    licenses: JinxxyLicense[];
    pagination: JinxxyPagination;
  }> {
    const response = await this.request<JinxxyLicensesResponse>('GET', '/licenses', {
      page: params?.page ?? 1,
      limit: params?.per_page ?? DEFAULT_PAGE_SIZE,
      product_id: params?.product_id,
      customer_id: params?.customer_id,
      status: params?.status,
      key: params?.key,
      short_key: params?.short_key,
    });

    const rawLicenses = response.results ?? response.licenses ?? [];
    const licenses =
      rawLicenses.length === 0
        ? []
        : (
            await Promise.all(
              rawLicenses.map(async (license) => {
                if (this.isFullLicense(license)) {
                  return license;
                }

                return this.getLicense(license.id);
              })
            )
          ).filter((license): license is JinxxyLicense => license !== null);

    return {
      licenses,
      pagination: response.pagination ?? this.getDefaultPagination(),
    };
  }

  /**
   * Map raw Jinxxy API license (GET /licenses/{id}) to JinxxyLicense.
   * API returns inventory_item, user, activations - not flat product_id/status.
   */
  private mapRawLicenseToLicense(raw: JinxxyLicenseRaw): JinxxyLicense {
    const inv = raw.inventory_item;
    return {
      id: raw.id,
      key: raw.key,
      product_id: inv?.target_id ?? '',
      product_version_id: inv?.target_version_id,
      customer_id: raw.user?.id,
      status: 'active', // Jinxxy API has no status; existence implies valid (matches jinx-master)
      created_at: '',
      activation_count: raw.activations?.total_count ?? 0,
      max_activations: 0,
      order_id: inv?.order?.id,
    };
  }

  private isFullLicense(
    license: JinxxyLicense | JinxxyLicenseListResult
  ): license is JinxxyLicense {
    return 'key' in license && 'product_id' in license && 'status' in license;
  }

  /**
   * Get a specific license by ID.
   * API returns the license object directly (not wrapped in { license: ... }).
   */
  async getLicense(licenseId: string): Promise<JinxxyLicense | null> {
    try {
      const data = await this.request<JinxxyLicenseResponse | JinxxyLicenseRaw>(
        'GET',
        `/licenses/${licenseId}`
      );

      const raw = (data as JinxxyLicenseResponse).license ?? (data as JinxxyLicenseRaw);
      if (!raw?.id) return null;

      return this.mapRawLicenseToLicense(raw as JinxxyLicenseRaw);
    } catch (error) {
      if (error instanceof JinxxyApiError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /** UUID format: 8-4-4-4-12 hex */
  private static readonly UUID_REGEX =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  /** Short key format: 4 alphanumeric - 12 hex (matches jinx-master) */
  private static readonly SHORT_KEY_REGEX = /^[A-Za-z0-9]{4}-[a-fA-F0-9]{12}$/;

  /**
   * Normalize license key for Jinxxy API lookup (matches jinx-master behavior).
   * - UUID/long key: full lowercase
   * - Short key: hex suffix lowercase (API may be case-sensitive)
   */
  private static normalizeLicenseKeyForApi(key: string): string {
    const trimmed = key.trim();
    if (JinxxyApiClient.UUID_REGEX.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    if (JinxxyApiClient.SHORT_KEY_REGEX.test(trimmed)) {
      const [prefix, suffix] = trimmed.split('-');
      return `${prefix}-${(suffix ?? '').toLowerCase()}`;
    }
    return trimmed;
  }

  /**
   * Verify a license by key (full UUID) or short_key.
   * Two-step flow (matches jinx-master): list returns minimal { id }; fetch full license by id.
   * Keys are normalized before API call (lowercase) to match jinx-master behavior.
   */
  async verifyLicenseByKey(licenseKey: string): Promise<{
    valid: boolean;
    license: JinxxyLicense | null;
    error?: string;
  }> {
    const trimmed = licenseKey.trim();
    const isUuid = JinxxyApiClient.UUID_REGEX.test(trimmed);
    const normalizedKey = JinxxyApiClient.normalizeLicenseKeyForApi(trimmed);

    // Step 1: GET /licenses?key=... or short_key=... returns minimal results { id, user, short_key }
    const params = isUuid ? { key: normalizedKey } : { short_key: normalizedKey };
    const listResponse = await this.request<JinxxyLicenseListResponse>('GET', '/licenses', params);

    const results = listResponse.results ?? [];
    const first = results[0];
    const licenseId = first?.id;

    if (!licenseId) {
      return {
        valid: false,
        license: null,
        error: 'License not found',
      };
    }

    // Step 2: GET /licenses/{id} returns full license (inventory_item, activations, etc.)
    const license = await this.getLicense(licenseId);
    if (!license) {
      return {
        valid: false,
        license: null,
        error: 'License not found',
      };
    }

    // Jinxxy API has no status field; existence implies valid (matches jinx-master)
    const isValid =
      license.status === 'active' &&
      (!license.expires_at || new Date(license.expires_at) > new Date());

    return {
      valid: isValid,
      license,
      error: isValid ? undefined : `License is ${license.status ?? 'invalid'}`,
    };
  }

  /**
   * Verify a license and recover the purchaser email from the linked order or customer.
   *
   * Jinxxy Creator API references:
   * - https://api.creators.jinxxy.com/v1/docs
   * - https://api.creators.jinxxy.com/v1/openapi.json
   */
  async verifyLicenseWithBuyerByKey(licenseKey: string): Promise<{
    valid: boolean;
    license: JinxxyLicense | null;
    purchaserEmail?: string;
    providerUserId?: string;
    externalOrderId?: string;
    providerProductId?: string;
    error?: string;
  }> {
    const result = await this.verifyLicenseByKey(licenseKey);
    if (!result.valid || !result.license) {
      return result;
    }

    const resolvedIdentity = await this.resolveBuyerIdentity(result.license);
    return {
      ...result,
      purchaserEmail: resolvedIdentity.purchaserEmail,
      providerUserId: resolvedIdentity.providerUserId,
      externalOrderId: result.license.order_id ?? result.license.id ?? undefined,
      providerProductId: result.license.product_id ?? undefined,
    };
  }

  private normalizeEmail(email?: string | null): string | undefined {
    const normalized = email?.trim().toLowerCase();
    return normalized ? normalized : undefined;
  }

  private async resolveBuyerIdentity(license: JinxxyLicense): Promise<{
    purchaserEmail?: string;
    providerUserId?: string;
  }> {
    const customerIds = new Set<string>();
    let providerUserId = license.customer_id;

    if (license.order_id) {
      const order = await this.getOrder(license.order_id);
      const orderEmail = this.normalizeEmail(order?.email);
      providerUserId ??= order?.customer_id;
      if (orderEmail) {
        return {
          purchaserEmail: orderEmail,
          providerUserId,
        };
      }
      if (order?.customer_id) {
        customerIds.add(order.customer_id);
      }
    }

    if (license.customer_id) {
      customerIds.add(license.customer_id);
    }

    for (const customerId of customerIds) {
      const customer = await this.getCustomer(customerId);
      const customerEmail = this.normalizeEmail(customer?.email);
      if (customerEmail) {
        return {
          purchaserEmail: customerEmail,
          providerUserId: customer?.id ?? providerUserId ?? customerId,
        };
      }
    }

    return {
      providerUserId,
    };
  }

  /**
   * Get activations for a license
   */
  async getLicenseActivations(
    licenseId: string,
    params?: PaginationParams
  ): Promise<{
    activations: Array<{
      id: string;
      license_id: string;
      device_identifier: string;
      device_name?: string;
      ip_address?: string;
      activated_at: string;
      last_seen_at?: string;
      metadata?: Record<string, unknown>;
    }>;
    pagination: JinxxyPagination;
  }> {
    const response = await this.request<JinxxyActivationsResponse>(
      'GET',
      `/licenses/${licenseId}/activations`,
      {
        page: params?.page ?? 1,
        per_page: params?.per_page ?? DEFAULT_PAGE_SIZE,
      }
    );

    return {
      activations: response.activations ?? [],
      pagination: response.pagination ?? this.getDefaultPagination(),
    };
  }

  // ============================================================================
  // ORDER ENDPOINTS
  // ============================================================================

  /**
   * List all orders with optional filtering
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
    pagination: JinxxyPagination;
  }> {
    const response = await this.request<JinxxyOrdersResponse>('GET', '/orders', {
      page: params?.page ?? 1,
      per_page: params?.per_page ?? DEFAULT_PAGE_SIZE,
      product_id: params?.product_id,
      customer_id: params?.customer_id,
      status: params?.status,
      email: params?.email,
    });

    return {
      orders: response.orders ?? [],
      pagination: response.pagination ?? this.getDefaultPagination(),
    };
  }

  /**
   * Get a specific order by ID
   */
  async getOrder(orderId: string): Promise<JinxxyOrder | null> {
    try {
      const response = await this.request<JinxxyOrderResponse>('GET', `/orders/${orderId}`);

      return response.order ?? null;
    } catch (error) {
      if (error instanceof JinxxyApiError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Find orders by customer email
   */
  async getOrdersByEmail(email: string): Promise<JinxxyOrder[]> {
    const allOrders: JinxxyOrder[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const { orders, pagination } = await this.getOrders({
        page,
        per_page: DEFAULT_PAGE_SIZE,
        email,
      });

      allOrders.push(...orders);
      hasMore = pagination.has_next;
      page++;
    }

    return allOrders;
  }

  /**
   * Find orders by Discord ID
   */
  async getOrdersByDiscordId(discordId: string): Promise<JinxxyOrder[]> {
    // Note: The API may not have a direct Discord ID filter, so we may need to
    // search through orders or use a different approach
    // For now, we'll search through all orders (this could be inefficient)
    const allOrders: JinxxyOrder[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const { orders, pagination } = await this.getOrders({
        page,
        per_page: DEFAULT_PAGE_SIZE,
      });

      // Filter by Discord ID
      const matchingOrders = orders.filter((order) => order.discord_id === discordId);
      allOrders.push(...matchingOrders);
      hasMore = pagination.has_next;
      page++;
    }

    return allOrders;
  }

  // ============================================================================
  // PAGINATION HELPERS
  // ============================================================================

  /**
   * Get all pages of licenses
   */
  async getAllLicenses(params?: {
    product_id?: string;
    customer_id?: string;
    status?: string;
  }): Promise<JinxxyLicense[]> {
    const allLicenses: JinxxyLicense[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const { licenses, pagination } = await this.getLicenses({
        page,
        per_page: DEFAULT_PAGE_SIZE,
        ...params,
      });

      allLicenses.push(...licenses);
      hasMore = pagination.has_next;
      page++;
    }

    return allLicenses;
  }

  /**
   * Get all pages of orders
   */
  async getAllOrders(params?: {
    product_id?: string;
    customer_id?: string;
    status?: string;
  }): Promise<JinxxyOrder[]> {
    const allOrders: JinxxyOrder[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const { orders, pagination } = await this.getOrders({
        page,
        per_page: DEFAULT_PAGE_SIZE,
        ...params,
      });

      allOrders.push(...orders);
      hasMore = pagination.has_next;
      page++;
    }

    return allOrders;
  }

  /**
   * Default pagination object for error cases
   */
  private getDefaultPagination(): JinxxyPagination {
    return {
      page: 1,
      per_page: DEFAULT_PAGE_SIZE,
      total: 0,
      total_pages: 0,
      has_next: false,
      has_prev: false,
    };
  }
}

// Re-export types and errors
export * from './types';
