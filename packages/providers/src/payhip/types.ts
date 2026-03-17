/**
 * Payhip API Types
 *
 * References:
 * - https://help.payhip.com/article/115-webhooks
 * - https://help.payhip.com/article/317-software-license-keys-new
 */

// ============================================================================
// ERROR TYPES
// ============================================================================

export class PayhipApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly errorCode?: string
  ) {
    super(message);
    this.name = 'PayhipApiError';
  }
}

export class PayhipRateLimitError extends PayhipApiError {
  constructor(
    message = 'Rate limit exceeded',
    public readonly retryAfter?: number
  ) {
    super(message, 429, 'rate_limit_exceeded');
    this.name = 'PayhipRateLimitError';
  }
}

// ============================================================================
// ADAPTER CONFIG
// ============================================================================

/**
 * Configuration for the Payhip adapter.
 * The global API key is used for webhook signature verification.
 * Per-product secret keys are required for license key verification.
 */
export interface PayhipAdapterConfig {
  /** Global API key from Payhip Settings > Developer. Used for webhook signature verification. */
  apiKey?: string;
  /** Optional custom API base URL for testing */
  apiBaseUrl?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Maximum retries for rate-limited requests */
  maxRetries?: number;
}

// ============================================================================
// LICENSE KEY API TYPES (v2)
// ============================================================================

/**
 * License key verification response from GET /api/v2/license/verify
 * Doc: https://help.payhip.com/article/317-software-license-keys-new
 */
export interface PayhipLicenseVerifyData {
  /** Whether the license key is enabled */
  enabled: boolean;
  /** Product permalink (e.g., "RGsF") — same as items[].product_key in webhooks */
  product_link: string;
  /** The license key itself */
  license_key: string;
  /** Email of the buyer who owns this license */
  buyer_email: string;
  /** Number of times this key has been used/activated */
  uses: number;
  /** The name of the product as defined by the seller */
  product_name?: string;
  /** ISO 8601 date the key was created */
  date: string;
}

/**
 * Full response wrapper from Payhip license API
 */
export interface PayhipLicenseVerifyResponse {
  data?: PayhipLicenseVerifyData;
}

/**
 * Normalized result from license key verification
 */
export interface PayhipLicenseVerifyResult {
  valid: boolean;
  data?: PayhipLicenseVerifyData;
  /** The product-secret-key that matched (for reference) */
  matchedProductPermalink?: string;
  error?: string;
}

// ============================================================================
// WEBHOOK PAYLOAD TYPES
// ============================================================================

/**
 * A single item in a Payhip webhook payload.
 * Appears in both `paid` and `refunded` events.
 */
export interface PayhipWebhookItem {
  /** Numeric product ID */
  product_id: string;
  /** Human-readable product name */
  product_name: string;
  /** Product permalink (e.g., "RGsF") — used as product identifier for license API */
  product_key: string;
  /** Payhip product URL */
  product_permalink: string;
  quantity: string;
  on_sale: boolean;
  used_coupon: boolean;
  used_social_discount: boolean;
  used_cross_sell_discount: boolean;
  used_upgrade_discount: boolean;
  promoted_by_affiliate: boolean;
  has_variant: boolean;
  variant_name?: string;
}

/**
 * Payhip `paid` webhook payload.
 * Doc: https://help.payhip.com/article/115-webhooks
 */
export interface PayhipPaidPayload {
  type: 'paid';
  /** Transaction ID */
  id: string;
  /** Buyer email */
  email: string;
  currency: string;
  /** Price in cents/pennies */
  price: number;
  vat_applied: boolean;
  ip_address?: string;
  items: PayhipWebhookItem[];
  payment_type?: string;
  stripe_fee?: number;
  payhip_fee?: number;
  unconsented_from_emails: boolean;
  is_gift: boolean;
  /** Unix timestamp of the transaction */
  date: number;
  /** SHA-256 of the creator's API key — used for webhook signature verification */
  signature: string;
}

/**
 * Payhip `refunded` webhook payload.
 * Doc: https://help.payhip.com/article/115-webhooks
 */
export interface PayhipRefundedPayload extends Omit<PayhipPaidPayload, 'type'> {
  type: 'refunded';
  /** Amount refunded in cents/pennies. If equals price, it is a full refund. */
  amount_refunded: number;
  /** Unix timestamp of the refund */
  date_refunded: number;
  /** Unix timestamp when the original transaction was created */
  date_created: number;
}

/**
 * Payhip `subscription.created` webhook payload.
 */
export interface PayhipSubscriptionCreatedPayload {
  type: 'subscription.created';
  subscription_id: string;
  customer_id: string;
  status: string;
  customer_email: string;
  plan_name: string;
  product_name: string;
  product_link: string;
  gdpr_consent: string;
  date_subscription_started: number;
  customer_first_name?: string;
  customer_last_name?: string;
  signature: string;
}

/**
 * Payhip `subscription.deleted` webhook payload.
 * Extends subscription.created but overrides `type` and `status`.
 */
export interface PayhipSubscriptionDeletedPayload
  extends Omit<PayhipSubscriptionCreatedPayload, 'type' | 'status'> {
  type: 'subscription.deleted';
  status: 'canceled';
  date_subscription_deleted: number;
}

/**
 * Union of all Payhip webhook payloads.
 */
export type PayhipWebhookPayload =
  | PayhipPaidPayload
  | PayhipRefundedPayload
  | PayhipSubscriptionCreatedPayload
  | PayhipSubscriptionDeletedPayload;

// ============================================================================
// NORMALIZED EVIDENCE
// ============================================================================

/**
 * Normalized Payhip evidence for the verification pipeline.
 */
export interface PayhipEvidence {
  provider: 'payhip';
  /** Buyer email (normalized/lowercased) */
  providerAccountRef: string;
  /** Product IDs or permalinks that were purchased */
  productRefs: string[];
  evidenceType: 'purchase' | 'license';
  /** ISO timestamp when evidence was observed */
  observedAt: string;
  /** Transaction ID or license key */
  rawRef: string;
  /** Whether this purchase/license has been refunded or disabled */
  refunded: boolean;
  /** License key if applicable */
  licenseKey?: string;
  /** Buyer email */
  email?: string;
}

/**
 * Normalize a Payhip license verify result into evidence.
 */
export function normalizeLicenseToEvidence(
  licenseKey: string,
  data: PayhipLicenseVerifyData
): PayhipEvidence {
  return {
    provider: 'payhip',
    providerAccountRef: data.buyer_email.toLowerCase().trim(),
    productRefs: [data.product_link],
    evidenceType: 'license',
    observedAt: data.date,
    rawRef: licenseKey,
    refunded: !data.enabled,
    licenseKey,
    email: data.buyer_email,
  };
}

/**
 * Normalize a Payhip paid webhook item into evidence.
 */
export function normalizeWebhookItemToEvidence(
  payload: PayhipPaidPayload,
  item: PayhipWebhookItem
): PayhipEvidence {
  return {
    provider: 'payhip',
    providerAccountRef: payload.email.toLowerCase().trim(),
    productRefs: [item.product_id, item.product_key].filter(Boolean),
    evidenceType: 'purchase',
    observedAt: new Date(payload.date * 1000).toISOString(),
    rawRef: payload.id,
    refunded: false,
    email: payload.email,
  };
}
