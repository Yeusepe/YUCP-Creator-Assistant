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
    message: string = 'Rate limit exceeded',
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
  key: string;
  short_key: string;
  user?: { id: string };
  inventory_item?: {
    target_id: string;
    target_version_id?: string;
    item?: { name: string };
    order?: { id: string; payment_status?: string };
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
export interface JinxxyOrder {
  id: string;
  customer_id?: string;
  product_id: string;
  status: 'completed' | 'refunded' | 'disputed' | 'pending' | 'cancelled';
  total: number;
  currency: string;
  created_at: string;
  updated_at?: string;
  refunded_at?: string;
  email?: string;
  discord_id?: string;
  license_id?: string;
  quantity: number;
  discount_code?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Jinxxy API response wrapper for order list
 */
export interface JinxxyOrdersResponse {
  success: boolean;
  orders?: JinxxyOrder[];
  pagination?: JinxxyPagination;
  error?: string;
  message?: string;
}

/**
 * Jinxxy API response wrapper for single order
 */
export interface JinxxyOrderResponse {
  success: boolean;
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
export function getOrderStatus(order: JinxxyOrder): 'completed' | 'refunded' | 'disputed' | 'pending' | 'cancelled' {
  return order.status;
}

/**
 * Check if an order is still valid (completed and not refunded/disputed)
 */
export function isOrderValid(order: JinxxyOrder): boolean {
  return order.status === 'completed';
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
  return {
    provider: 'jinxxy',
    providerAccountRef: order.customer_id ?? order.email ?? 'unknown',
    productRefs: [order.product_id],
    evidenceType: 'purchase',
    observedAt: order.created_at,
    rawRef: order.id,
    refunded: order.status === 'refunded',
    licenseKey: order.license_id,
    email: order.email,
    discordId: order.discord_id,
  };
}
