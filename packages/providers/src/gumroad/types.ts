/**
 * Gumroad API Types
 *
 * Type definitions for Gumroad OAuth and API responses.
 * Reference: https://gumroad.com/api
 */

// ============================================================================
// OAUTH TYPES
// ============================================================================

/**
 * Gumroad OAuth token response
 */
export interface GumroadTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  created_at?: number;
}

/**
 * Gumroad OAuth error response
 */
export interface GumroadOAuthError {
  error: string;
  error_description?: string;
}

// ============================================================================
// USER API TYPES
// ============================================================================

/**
 * Gumroad user resource from /users/@me
 */
export interface GumroadUser {
  id: number;
  name: string;
  email: string;
  bio?: string;
  twitter_handle?: string;
  url?: string;
  created_at: string;
}

/**
 * Gumroad API response wrapper for user
 */
export interface GumroadUserResponse {
  success: boolean;
  user: GumroadUser;
  message?: string;
}

// ============================================================================
// SALES API TYPES
// ============================================================================

/**
 * Gumroad sale resource from /sales
 */
export interface GumroadSale {
  id: string;
  product_id: string;
  product_name: string;
  email: string;
  full_name?: string;
  purchaser_id?: number;
  price: number;
  currency: string;
  quantity: number;
  refunded: boolean;
  refunded_at?: string;
  chargebacked: boolean;
  chargebacked_at?: string;
  disputed: boolean;
  disputed_at?: string;
  created_at: string;
  purchase_date: string;
  license_key?: string;
  license_code?: string;
  custom_fields?: Record<string, string>;
  variants?: string;
  recurrence?: string;
  offer_code?: string;
  order_id?: string;
  subscription_id?: string | number | null;
  sale_timestamp: string;
}

/**
 * Gumroad API response wrapper for sales list
 */
export interface GumroadSalesResponse {
  success: boolean;
  sales: GumroadSale[];
  next_page_url?: string;
  message?: string;
}

/**
 * Gumroad API response wrapper for a single sale (GET /v2/sales/:id)
 */
export interface GumroadSaleResponse {
  success: boolean;
  sale: GumroadSale;
  message?: string;
}

// ============================================================================
// PRODUCTS API TYPES
// ============================================================================

/**
 * Gumroad product variant group from GET /products.
 * Products expose variant groups with `variants[].options[]`.
 * See: https://gumroad.com/api#products
 */
export interface GumroadProductVariant {
  title?: string;
  name?: string;
  options?: Array<string | { name?: string; title?: string; value?: string }>;
}

/**
 * Gumroad recurrence price entry from GET /products.
 * Tiered memberships expose `recurrences` and `recurrence_prices`.
 * See: https://gumroad.com/api#products
 */
export type GumroadRecurrencePrice =
  | number
  | string
  | {
      cents?: number;
      price?: number;
      amount_cents?: number;
      formatted_price?: string;
      currency?: string;
    };

export interface GumroadTierRefInput {
  productId: string;
  variantTitle: string;
  optionLabel: string;
  recurrence?: string;
}

export function normalizeGumroadWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeGumroadCanonicalTierPart(value: string): string {
  return normalizeGumroadWhitespace(value).normalize('NFKC').toLowerCase();
}

function normalizeGumroadOpaqueTierPart(value: string): string {
  return normalizeGumroadWhitespace(value).normalize('NFKC');
}

export function formatGumroadCanonicalTierPart(
  value: string,
  options?: { preserveCase?: boolean }
): string {
  const canonicalValue = options?.preserveCase
    ? normalizeGumroadOpaqueTierPart(value)
    : normalizeGumroadCanonicalTierPart(value);
  return `${canonicalValue.length}:${canonicalValue}`;
}

export function parseGumroadVariantSelection(
  value: unknown
): { variantTitle: string; optionLabel: string } | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = normalizeGumroadWhitespace(value);
  if (!normalized) {
    return undefined;
  }
  const separatorIndex = normalized.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === normalized.length - 1) {
    return undefined;
  }

  const variantTitle = normalizeGumroadWhitespace(normalized.slice(0, separatorIndex));
  const optionLabel = normalizeGumroadWhitespace(normalized.slice(separatorIndex + 1));
  if (!variantTitle || !optionLabel) {
    return undefined;
  }

  return { variantTitle, optionLabel };
}

export function normalizeGumroadRecurrence(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

export function buildGumroadTierRef({
  productId,
  variantTitle,
  optionLabel,
  recurrence,
}: GumroadTierRefInput): string {
  const parts = [
    'gumroad',
    'product',
    formatGumroadCanonicalTierPart(productId, { preserveCase: true }),
    'variant',
    formatGumroadCanonicalTierPart(variantTitle),
    'option',
    formatGumroadCanonicalTierPart(optionLabel),
  ];
  if (recurrence) {
    parts.push('recurrence', formatGumroadCanonicalTierPart(recurrence));
  }
  return parts.join('|');
}

export function buildGumroadTierRefFromPurchaseSelection(input: {
  productId: unknown;
  variants: unknown;
  recurrence?: unknown;
}): string | undefined {
  /**
   * Gumroad product docs: https://gumroad.com/api#products
   * Gumroad sales docs: https://gumroad.com/api#sales
   * Current Gumroad sale and webhook payloads expose the purchased selection through
   * `variants` and the billing cadence through `recurrence`, so the stable tier
   * identity must be rebuilt from those documented fields.
   */
  const productId =
    typeof input.productId === 'string' ? normalizeGumroadWhitespace(input.productId) : '';
  const selection = parseGumroadVariantSelection(input.variants);
  const recurrence = normalizeGumroadRecurrence(input.recurrence);
  if (!productId || !selection) {
    return undefined;
  }

  return buildGumroadTierRef({
    productId,
    variantTitle: selection.variantTitle,
    optionLabel: selection.optionLabel,
    recurrence,
  });
}

/**
 * Gumroad product resource from /products/:id
 */
export interface GumroadProduct {
  id: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  short_url: string;
  custom_permalink?: string;
  formatted_price: string;
  purchase_type: 'buy' | 'subscription' | 'pay_what_you_want';
  published: boolean;
  created_at: string;
  deleted_at?: string;
  is_tiered_membership?: boolean;
  recurrences?: string[];
  recurrence_prices?: Record<string, GumroadRecurrencePrice>;
  variants?: GumroadProductVariant[];
  subscription_duration?: 'monthly' | 'yearly';
  max_purchase_count?: number;
}

/**
 * Gumroad API response wrapper for product
 */
export interface GumroadProductResponse {
  success: boolean;
  product: GumroadProduct;
  message?: string;
}

/**
 * Gumroad API response wrapper for products list
 */
export interface GumroadProductsResponse {
  success: boolean;
  products: GumroadProduct[];
  next_page_url?: string;
  message?: string;
}

// ============================================================================
// EVIDENCE TYPES (Normalized)
// ============================================================================

/**
 * Gumroad purchase evidence for verification
 */
export interface GumroadPurchaseEvidence {
  /** Provider identifier */
  provider: 'gumroad';
  /** Gumroad user ID */
  providerAccountRef: string;
  /** Gumroad product IDs purchased */
  productRefs: string[];
  /** Type of evidence */
  evidenceType: 'purchase';
  /** ISO timestamp when evidence was observed */
  observedAt: string;
  /** Reference to the sale record */
  rawRef: string;
  /** Whether this purchase has been refunded */
  refunded: boolean;
  /** Whether this purchase has been chargebacked */
  chargebacked: boolean;
  /** Whether this purchase has been disputed */
  disputed: boolean;
  /** Email used for purchase (may be redacted) */
  email?: string;
  /** License key if applicable */
  licenseKey?: string;
}

/**
 * Status of a purchase (derived from sale record)
 */
export type PurchaseStatus = 'active' | 'refunded' | 'chargebacked' | 'disputed';

/**
 * Get the effective status of a sale
 */
export function getSaleStatus(sale: GumroadSale): PurchaseStatus {
  if (sale.chargebacked) return 'chargebacked';
  if (sale.refunded) return 'refunded';
  if (sale.disputed) return 'disputed';
  return 'active';
}

/**
 * Check if a sale is still valid (not refunded/chargebacked/disputed)
 */
export function isSaleValid(sale: GumroadSale): boolean {
  return !sale.refunded && !sale.chargebacked && !sale.disputed;
}

/**
 * Normalize a Gumroad sale into purchase evidence
 */
export function normalizeSaleToEvidence(
  sale: GumroadSale,
  gumroadUserId: string
): GumroadPurchaseEvidence {
  return {
    provider: 'gumroad',
    providerAccountRef: gumroadUserId,
    productRefs: [sale.product_id],
    evidenceType: 'purchase',
    observedAt: sale.created_at,
    rawRef: sale.id,
    refunded: sale.refunded,
    chargebacked: sale.chargebacked,
    disputed: sale.disputed,
    email: sale.email,
    licenseKey: sale.license_key ?? sale.license_code,
  };
}

// ============================================================================
// ADAPTER CONFIG TYPES
// ============================================================================

/**
 * Configuration for Gumroad adapter
 */
export interface GumroadAdapterConfig {
  /** Gumroad OAuth client ID */
  clientId: string;
  /** Gumroad OAuth client secret */
  clientSecret: string;
  /** OAuth redirect URI */
  redirectUri: string;
  /** Optional custom API base URL (for testing) */
  apiBaseUrl?: string;
  /** Optional custom OAuth base URL (for testing) */
  oauthBaseUrl?: string;
}

/**
 * OAuth state data for CSRF protection
 */
export interface OAuthState {
  /** Random state token */
  state: string;
  /** Auth user ID for user-first context */
  authUserId: string;
  /** Subject ID (YUCP user) */
  subjectId?: string;
  /** Timestamp when state was created */
  createdAt: number;
  /** Optional PKCE code verifier */
  codeVerifier?: string;
}

/**
 * Result of OAuth authorization URL generation
 */
export interface AuthorizationUrlResult {
  /** The authorization URL to redirect the user to */
  url: string;
  /** The state parameter for CSRF validation */
  state: string;
  /** PKCE code verifier (if PKCE was used) */
  codeVerifier?: string;
}

/**
 * Gumroad license verification response (POST /v2/licenses/verify)
 * See: https://gumroad.com/api#post-v2-licenses-verify
 */
export interface GumroadLicenseVerifyResponse {
  success: boolean;
  message?: string;
  uses?: number;
  purchase?: {
    test?: boolean;
    email?: string;
    sale_id?: string;
    license_key?: string;
    refunded?: boolean;
    disputed?: boolean;
    chargebacked?: boolean;
    [key: string]: unknown;
  };
}

/**
 * Result of OAuth completion
 */
export interface OAuthCompletionResult {
  /** Whether the OAuth flow completed successfully */
  success: boolean;
  /** Gumroad user ID */
  gumroadUserId?: string;
  /** Encrypted access token payload */
  encryptedAccessToken?: unknown;
  /** Encrypted refresh token payload */
  encryptedRefreshToken?: unknown;
  /** Token expiration timestamp */
  expiresAt?: number;
  /** Error message if failed */
  error?: string;
}
