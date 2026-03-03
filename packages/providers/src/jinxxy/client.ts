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

import type {
  JinxxyAdapterConfig,
  JinxxyUser,
  JinxxyUserResponse,
  JinxxyProduct,
  JinxxyProductsResponse,
  JinxxyProductResponse,
  JinxxyCustomer,
  JinxxyCustomersResponse,
  JinxxyCustomerResponse,
  JinxxyLicense,
  JinxxyLicensesResponse,
  JinxxyLicenseResponse,
  JinxxyActivationsResponse,
  JinxxyOrder,
  JinxxyOrdersResponse,
  JinxxyOrderResponse,
  JinxxyPagination,
  PaginationParams,
  JinxxyApiErrorResponse,
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
   * Create client from environment variables
   */
  static fromEnv(): JinxxyApiClient {
    const apiKey = process.env.JINXXY_API_KEY;
    if (!apiKey) {
      throw new Error('JINXXY_API_KEY environment variable is required');
    }
    return new JinxxyApiClient({
      apiKey,
      apiBaseUrl: process.env.JINXXY_API_BASE_URL,
      timeout: process.env.JINXXY_API_TIMEOUT
        ? parseInt(process.env.JINXXY_API_TIMEOUT, 10)
        : undefined,
    });
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

    // Add query parameters
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.append(key, String(value));
        }
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers: {
          'x-api-key': this.apiKey,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000;

        if (retryCount < this.maxRetries) {
          await this.sleep(retryAfterMs * (retryCount + 1));
          return this.request<T>(method, path, params, body, retryCount + 1);
        }

        throw new JinxxyRateLimitError(
          'Rate limit exceeded after maximum retries',
          retryAfterMs
        );
      }

      // Handle other errors
      if (!response.ok) {
        const errorBody = (await this.safeParseJson(response)) as JinxxyApiErrorResponse | null;
        const errorMessage = errorBody?.error ?? errorBody?.message ?? `HTTP ${response.status}`;
        const errorCode = errorBody?.error;

        throw new JinxxyApiError(
          errorMessage,
          response.status,
          errorCode,
          errorBody?.details
        );
      }

      // Parse successful response
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
   * Get the authenticated user's profile
   */
  async getCurrentUser(): Promise<JinxxyUser> {
    const response = await this.request<JinxxyUserResponse>('GET', '/me');

    if (!response.success || !response.user) {
      throw new JinxxyApiError(
        response.error ?? 'Failed to get user profile',
        401,
        'unauthorized'
      );
    }

    return response.user;
  }

  // ============================================================================
  // PRODUCT ENDPOINTS
  // ============================================================================

  /**
   * List all products
   */
  async getProducts(params?: PaginationParams): Promise<{
    products: JinxxyProduct[];
    pagination: JinxxyPagination;
  }> {
    const response = await this.request<JinxxyProductsResponse>('GET', '/products', {
      page: params?.page ?? 1,
      per_page: params?.per_page ?? DEFAULT_PAGE_SIZE,
    });

    return {
      products: response.products ?? [],
      pagination: response.pagination ?? this.getDefaultPagination(),
    };
  }

  /**
   * Get a specific product by ID
   */
  async getProduct(productId: string): Promise<JinxxyProduct | null> {
    try {
      const response = await this.request<JinxxyProductResponse>(
        'GET',
        `/products/${productId}`
      );

      return response.product ?? null;
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
  async getLicenses(params?: PaginationParams & {
    product_id?: string;
    customer_id?: string;
    status?: string;
    key?: string;
    short_key?: string;
  }): Promise<{
    licenses: JinxxyLicense[];
    pagination: JinxxyPagination;
  }> {
    const response = await this.request<JinxxyLicensesResponse>('GET', '/licenses', {
      page: params?.page ?? 1,
      per_page: params?.per_page ?? DEFAULT_PAGE_SIZE,
      product_id: params?.product_id,
      customer_id: params?.customer_id,
      status: params?.status,
      key: params?.key,
      short_key: params?.short_key,
    });

    return {
      licenses: response.licenses ?? [],
      pagination: response.pagination ?? this.getDefaultPagination(),
    };
  }

  /**
   * Get a specific license by ID
   */
  async getLicense(licenseId: string): Promise<JinxxyLicense | null> {
    try {
      const response = await this.request<JinxxyLicenseResponse>(
        'GET',
        `/licenses/${licenseId}`
      );

      return response.license ?? null;
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

  /**
   * Verify a license by key (full UUID) or short_key.
   * Tries key (UUID) first; if input does not match UUID format, tries short_key.
   */
  async verifyLicenseByKey(licenseKey: string): Promise<{
    valid: boolean;
    license: JinxxyLicense | null;
    error?: string;
  }> {
    const isUuid = JinxxyApiClient.UUID_REGEX.test(licenseKey.trim());

    // Try key (UUID) first, then short_key if input doesn't match UUID
    const params = isUuid ? { key: licenseKey } : { short_key: licenseKey };
    const response = await this.request<JinxxyLicensesResponse>('GET', '/licenses', params);

    const license = response.licenses?.[0];

    if (!license) {
      return {
        valid: false,
        license: null,
        error: 'License not found',
      };
    }

    // Check if license is valid
    const isValid =
      license.status === 'active' &&
      (!license.expires_at || new Date(license.expires_at) > new Date());

    return {
      valid: isValid,
      license,
      error: isValid ? undefined : `License is ${license.status}`,
    };
  }

  /**
   * Get activations for a license
   */
  async getLicenseActivations(licenseId: string, params?: PaginationParams): Promise<{
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
  async getOrders(params?: PaginationParams & {
    product_id?: string;
    customer_id?: string;
    status?: string;
    email?: string;
  }): Promise<{
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
      const response = await this.request<JinxxyOrderResponse>(
        'GET',
        `/orders/${orderId}`
      );

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
