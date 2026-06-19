/**
 * Jinxxy Creator API Types
 *
 * Type definitions for Jinxxy Creator API responses.
 * Reference: https://api.creators.jinxxy.com/docs
 */

// ============================================================================
// API ERROR TYPES
// ============================================================================

/**
 * Jinxxy API error response
 */
export interface JinxxyApiErrorResponse {
  error?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Custom error class for Jinxxy API errors
 */
export class JinxxyApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly errorCode?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'JinxxyApiError';
  }
}

/**
 * Custom error class for rate limiting
 */
export class JinxxyRateLimitError extends JinxxyApiError {
  constructor(
    message = 'Rate limit exceeded',
    public readonly retryAfter?: number
  ) {
    super(message, 429, 'rate_limit_exceeded');
    this.name = 'JinxxyRateLimitError';
  }
}

// ============================================================================
// USER API TYPES
// ============================================================================

/**
 * Jinxxy user profile from /v1/me
 */
export interface JinxxyUser {
  id: string;
  username: string;
  email?: string;
  discord_id?: string;
  avatar_url?: string;
  created_at: string;
}

/**
 * Jinxxy API response wrapper for user
 */
export interface JinxxyUserResponse {
  success: boolean;
  user?: JinxxyUser;
  error?: string;
  message?: string;
}

// ============================================================================
// PRODUCT API TYPES
// ============================================================================

/**
 * Jinxxy product resource
 */
export interface JinxxyProductVersion {
  object?: string;
  id: string;
  name: string;
  /** https://api.creators.jinxxy.com/v1/openapi.json documents `price` as a number. */
  price: number;
}

export interface JinxxyProduct {
  id: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  status: 'draft' | 'published' | 'archived';
  created_at: string;
  updated_at?: string;
  external_url?: string;
  thumbnail_url?: string;
  versions?: JinxxyProductVersion[];
  url?: string;
  visibility?: string;
  base_price?: number;
  currency_code?: string;
}

/**
 * Jinxxy API response wrapper for product list.
 * API returns `results` (not `products`); we support both for compatibility.
 */
export interface JinxxyProductsResponse {
  success?: boolean;
  products?: JinxxyProduct[];
  /** API returns products in `results` */
  results?: JinxxyProduct[];
  pagination?: JinxxyPagination;
  page?: number;
  page_count?: number;
  cursor_count?: number;
  error?: string;
  message?: string;
}

/**
 * Jinxxy API response wrapper for single product
 */
export interface JinxxyProductResponse {
  success: boolean;
  product?: JinxxyProduct;
  error?: string;
  message?: string;
}

// ============================================================================
// CUSTOMER API TYPES
// ============================================================================

/**
 * Jinxxy customer resource
 */
export interface JinxxyCustomer {
  id: string;
  email?: string;
  discord_id?: string;
  username?: string;
  created_at: string;
  total_spent?: number;
  order_count?: number;
}

/**
 * Jinxxy API response wrapper for customer list
 */
export interface JinxxyCustomersResponse {
  success: boolean;
  customers?: JinxxyCustomer[];
  pagination?: JinxxyPagination;
  error?: string;
  message?: string;
}

/**
 * Jinxxy API response wrapper for single customer
 */
export interface JinxxyCustomerResponse {
  success: boolean;
  customer?: JinxxyCustomer;
  error?: string;
  message?: string;
}

// ============================================================================
// LICENSE API TYPES
// ============================================================================

/**
 * Jinxxy license resource
 */
export interface JinxxyLicense {
  id: string;
  key: string;
  product_id: string;
  product_version_id?: string;
  customer_id?: string;
  status: 'active' | 'disabled' | 'expired' | 'revoked';
  created_at: string;
  expires_at?: string;
  activated_at?: string;
  activation_count: number;
  max_activations: number;
  order_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Jinxxy license activation resource
 */
export interface JinxxyLicenseActivation {
  id: string;
  license_id: string;
  device_identifier: string;
  device_name?: string;
  ip_address?: string;
  activated_at: string;
  last_seen_at?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Raw license list item from GET /licenses?key=... or short_key=...
 * API returns minimal objects: { id, object, user, short_key } - no status, product_id, etc.
 * Must fetch full license via GET /licenses/{id} to get details (see jinx-master).
 */
export interface JinxxyLicenseListResult {
  id: string;
  object?: string;
  user?: { id: string };
  short_key?: string;
}

/**
 * Response from GET /licenses?key=... or short_key=...
 * Results are minimal (id, user, short_key) - must fetch full license by id.
 */
export interface JinxxyLicenseListResponse {
  results?: JinxxyLicenseListResult[];
  page?: number;
  page_count?: number;
  cursor_count?: number;
}

/**
 * Jinxxy API response wrapper for license list (when listing with product_id etc).
 * API returns `results`; list items may be minimal or full depending on endpoint.
 */
export interface JinxxyLicensesResponse {
  success?: boolean;
  licenses?: JinxxyLicense[];
  results?: JinxxyLicense[] | JinxxyLicenseListResult[];
  pagination?: JinxxyPagination;
  page?: number;
  page_count?: number;
  cursor_count?: number;
  error?: string;
  message?: string;
}

/**
 * Raw license from GET /licenses/{id} - actual API shape.
 * API returns this object directly (not wrapped in { license: ... }).
 */
export interface JinxxyLicenseRaw {
  id: string;
  object?: string;
  key: string;
  short_key: string;
  user?: JinxxyOrderUser;
  inventory_item?: {
    id?: string;
    object?: string;
    target_id: string;
    target_version_id?: string;
    target_type?: string;
    grant_id?: string | null;
    grant_type?: string | null;
    item?: { name: string };
    order?: { id: string; object?: string; payment_status?: string };
  };
  activations?: { total_count: number };
}

/**
 * Jinxxy API response wrapper for single license
 */
export interface JinxxyLicenseResponse {
  success: boolean;
  license?: JinxxyLicense;
  error?: string;
  message?: string;
}

/**
 * Jinxxy API response wrapper for license activations
 */
export interface JinxxyActivationsResponse {
  success: boolean;
  activations?: JinxxyLicenseActivation[];
  pagination?: JinxxyPagination;
  error?: string;
  message?: string;
}

// ============================================================================
// ORDER API TYPES
// ============================================================================

/**
 * Jinxxy order resource
 */
export interface JinxxyOrderUser {
  id: string;
  object?: string;
  name?: string;
  username?: string;
  profile_image?: unknown;
  updated_at?: string;
}

export interface JinxxyOrderItem {
  id: string;
  object?: string;
  name?: string;
  target_id?: string | null;
  target_type?: string;
  target_version_id?: string | null;
  seller?: JinxxyOrderUser | null;
  license_id?: string | null;
  license?: {
    id: string;
    object?: string;
    key?: string;
    short_key?: string;
  } | null;
}

export interface JinxxyOrder {
  id: string;
  object?: string;
  email?: string;
  paid_at?: string;
  user?: JinxxyOrderUser;
  payment_status?: string;
  payout_total?: number;
  checkout_fields?: Array<{ object?: string; answer: string; label: string }>;
  order_items?: JinxxyOrderItem[];
  customer_id?: string;
  product_id?: string;
  status?: 'completed' | 'refunded' | 'disputed' | 'pending' | 'cancelled' | string;
  total?: number;
  currency?: string;
  created_at?: string;
  updated_at?: string;
  refunded_at?: string;
  discord_id?: string;
  license_id?: string;
  quantity?: number;
  discount_code?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Jinxxy API response wrapper for order list
 */
export interface JinxxyOrdersResponse {
  success?: boolean;
  orders?: JinxxyOrder[];
  results?: JinxxyOrder[];
  pagination?: JinxxyPagination;
  page?: number;
  page_count?: number;
  cursor_count?: number;
  error?: string;
  message?: string;
}

/**
 * Jinxxy API response wrapper for single order
 */
export interface JinxxyOrderResponse {
  success?: boolean;
  order?: JinxxyOrder;
  error?: string;
  message?: string;
}

// ============================================================================
// PAGINATION TYPES
// ============================================================================

/**
 * Jinxxy pagination info
 */
export interface JinxxyPagination {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
  has_next: boolean;
  has_prev: boolean;
}

/**
 * Pagination query parameters
 */
export interface PaginationParams {
  page?: number;
  per_page?: number;
}

// ============================================================================
// EVIDENCE TYPES (Normalized)
// ============================================================================

/**
 * Jinxxy evidence for verification
 */
export interface JinxxyEvidence {
  /** Provider identifier */
  provider: 'jinxxy';
  /** Jinxxy customer ID or email hash */
  providerAccountRef: string;
  /** Jinxxy product IDs */
  productRefs: string[];
  /** Type of evidence */
  evidenceType: 'license' | 'purchase';
  /** ISO timestamp when evidence was observed */
  observedAt: string;
  /** Reference to the raw record (license or order ID) */
  rawRef: string;
  /** Whether this purchase has been refunded */
  refunded: boolean;
  /** License key if applicable */
  licenseKey?: string;
  /** Email if available */
  email?: string;
  /** Discord ID if available */
  discordId?: string;
  /** Provider tier/version refs if available */
  providerTierRefs?: string[];
}

/**
 * License verification result
 */
export interface LicenseVerificationResult {
  valid: boolean;
  license?: JinxxyLicense;
  error?: string;
}

/**
 * Purchase verification result
 */
export interface PurchaseVerificationResult {
  found: boolean;
  order?: JinxxyOrder;
  license?: JinxxyLicense;
  error?: string;
}

// ============================================================================
// ADAPTER CONFIG TYPES
// ============================================================================

/**
 * Configuration for Jinxxy adapter
 */
export interface JinxxyAdapterConfig {
  /** Jinxxy API key (from creator dashboard) */
  apiKey: string;
  /** Optional custom API base URL (for testing) */
  apiBaseUrl?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Maximum retries for rate-limited requests */
  maxRetries?: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get the effective status of an order
 */
export function getOrderStatus(
  order: JinxxyOrder
): 'completed' | 'refunded' | 'disputed' | 'pending' | 'cancelled' {
  const status = (order.status ?? order.payment_status ?? '').toLowerCase();
  if (status === 'paid' || status === 'completed') return 'completed';
  if (status === 'refunded' || status === 'partially_refunded') return 'refunded';
  if (status === 'disputed') return 'disputed';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return 'pending';
}

/**
 * Check if an order is still valid (completed and not refunded/disputed)
 */
export function isOrderValid(order: JinxxyOrder): boolean {
  return getOrderStatus(order) === 'completed';
}

/**
 * Check if a license is valid (active and not expired)
 */
export function isLicenseValid(license: JinxxyLicense): boolean {
  if (license.status !== 'active') {
    return false;
  }
  if (license.expires_at) {
    return new Date(license.expires_at) > new Date();
  }
  return true;
}

/**
 * Normalize a Jinxxy license into evidence
 */
export function normalizeLicenseToEvidence(
  license: JinxxyLicense,
  customer?: JinxxyCustomer
): JinxxyEvidence {
  return {
    provider: 'jinxxy',
    providerAccountRef: customer?.id ?? license.customer_id ?? 'unknown',
    productRefs: [license.product_id],
    evidenceType: 'license',
    observedAt: license.created_at,
    rawRef: license.id,
    refunded: license.status === 'revoked',
    licenseKey: license.key,
    email: customer?.email,
    discordId: customer?.discord_id,
  };
}

/**
 * Normalize a Jinxxy order into evidence
 */
export function normalizeOrderToEvidence(order: JinxxyOrder): JinxxyEvidence {
  const observedAt =
    [order.created_at, order.paid_at]
      .map((timestamp) => timestamp?.trim())
      .find((timestamp): timestamp is string => Boolean(timestamp)) ?? new Date(0).toISOString();
  const orderItems = order.order_items ?? [];
  const normalizedOrderProductId = order.product_id?.trim();
  const productRefs = normalizedOrderProductId
    ? [normalizedOrderProductId]
    : Array.from(
        new Set(
          orderItems
            .map((item) => item.target_id?.trim())
            .filter((targetId): targetId is string => Boolean(targetId))
        )
      );
  const orderItemWithLicense = orderItems.find((item) => item.license?.key || item.license_id);
  const licenseKey =
    order.license_id ??
    orderItemWithLicense?.license?.key ??
    orderItemWithLicense?.license_id ??
    undefined;
  const uniqueItemProductIds = Array.from(
    new Set(
      orderItems
        .map((item) => item.target_id?.trim())
        .filter((targetId): targetId is string => Boolean(targetId))
    )
  );
  const tierScopedItems = normalizedOrderProductId
    ? orderItems.filter((item) => item.target_id?.trim() === normalizedOrderProductId)
    : uniqueItemProductIds.length === 1
      ? orderItems
      : [];
  const providerTierRefs = Array.from(
    new Set(
      tierScopedItems
        .map((item) => item.target_version_id?.trim())
        .filter((providerTierRef): providerTierRef is string => Boolean(providerTierRef))
    )
  );

  return {
    provider: 'jinxxy',
    providerAccountRef: order.customer_id ?? order.user?.id ?? order.email ?? 'unknown',
    productRefs,
    evidenceType: 'purchase',
    observedAt,
    rawRef: order.id,
    refunded: getOrderStatus(order) === 'refunded',
    licenseKey,
    providerTierRefs: providerTierRefs.length > 0 ? providerTierRefs : undefined,
    email: order.email,
    discordId: order.discord_id,
  };
}
