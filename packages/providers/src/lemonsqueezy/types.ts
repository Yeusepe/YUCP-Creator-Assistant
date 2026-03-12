/**
 * Lemon Squeezy API types
 *
 * References:
 * - https://docs.lemonsqueezy.com/api
 * - https://docs.lemonsqueezy.com/api/license-api/validate-license-key
 */

// ============================================================================
// COMMON TYPES
// ============================================================================

export interface LemonSqueezyAdapterConfig {
  apiToken: string;
  apiBaseUrl?: string;
  licenseApiBaseUrl?: string;
  timeout?: number;
  maxRetries?: number;
}

export interface LemonSqueezyApiErrorResponse {
  errors?: Array<{
    status?: string;
    title?: string;
    detail?: string;
    source?: {
      pointer?: string;
      parameter?: string;
    };
  }>;
}

export class LemonSqueezyApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'LemonSqueezyApiError';
  }
}

export class LemonSqueezyRateLimitError extends LemonSqueezyApiError {
  constructor(
    message = 'Rate limit exceeded',
    public readonly retryAfter?: number
  ) {
    super(message, 429);
    this.name = 'LemonSqueezyRateLimitError';
  }
}

export interface LemonSqueezyPagination {
  currentPage: number;
  nextPage: number | null;
  previousPage: number | null;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface LemonSqueezyListResponse<T> {
  data: T[];
  meta?: {
    page?: {
      currentPage?: number;
      from?: number;
      lastPage?: number;
      perPage?: number;
      to?: number;
      total?: number;
    };
  };
  links?: {
    first?: string;
    last?: string;
    next?: string | null;
    prev?: string | null;
  };
}

// ============================================================================
// JSON:API RESOURCES
// ============================================================================

export interface LemonSqueezyStore {
  id: string;
  name: string;
  slug: string;
  domain?: string | null;
  status?: string | null;
  url?: string | null;
  createdAt?: string;
  updatedAt?: string;
  testMode?: boolean;
}

export interface LemonSqueezyProduct {
  id: string;
  storeId?: string;
  name: string;
  slug?: string | null;
  status?: string | null;
  description?: string | null;
  url?: string | null;
  testMode?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface LemonSqueezyVariant {
  id: string;
  productId?: string;
  name: string;
  slug?: string | null;
  description?: string | null;
  price?: number | null;
  status?: string | null;
  hasLicenseKeys?: boolean;
  licenseLengthValue?: number | null;
  licenseLengthUnit?: string | null;
  isSubscription?: boolean;
  testMode?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface LemonSqueezyOrder {
  id: string;
  storeId?: string;
  customerId?: string | null;
  identifier?: string | null;
  orderNumber?: number | null;
  userName?: string | null;
  userEmail?: string | null;
  currency?: string | null;
  currencyRate?: string | null;
  subtotal?: number | null;
  total?: number | null;
  tax?: number | null;
  status?: string | null;
  refunded?: boolean;
  refundedAt?: string | null;
  testMode?: boolean;
  firstOrderItem?: {
    id?: number | null;
    orderId?: number | null;
    productId?: number | null;
    variantId?: number | null;
    productName?: string | null;
    variantName?: string | null;
  };
  urls?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface LemonSqueezySubscription {
  id: string;
  storeId?: string;
  customerId?: string | null;
  orderId?: string | null;
  orderItemId?: string | null;
  productId?: number | null;
  variantId?: number | null;
  productName?: string | null;
  variantName?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  status?: string | null;
  statusFormatted?: string | null;
  cardBrand?: string | null;
  cardLastFour?: string | null;
  pause?: unknown;
  cancelled?: boolean;
  trialEndsAt?: string | null;
  billingAnchor?: number | null;
  firstSubscriptionItem?: {
    id?: number | null;
    subscriptionId?: number | null;
    priceId?: number | null;
    quantity?: number | null;
    createdAt?: string | null;
    updatedAt?: string | null;
  };
  renewsAt?: string | null;
  endsAt?: string | null;
  testMode?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface LemonSqueezyLicenseKey {
  id: string;
  storeId?: string;
  customerId?: string | null;
  orderId?: string | null;
  orderItemId?: string | null;
  productId?: number | null;
  variantId?: number | null;
  userName?: string | null;
  userEmail?: string | null;
  key?: string | null;
  keyShort?: string | null;
  activationLimit?: number | null;
  instancesCount?: number | null;
  disabled?: boolean;
  status?: string | null;
  expiresAt?: string | null;
  testMode?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface LemonSqueezyWebhook {
  id: string;
  storeId?: string;
  url: string;
  events: string[];
  secret?: string | null;
  testMode?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

// ============================================================================
// LICENSE API TYPES
// ============================================================================

export interface LemonSqueezyLicenseValidationResponse {
  valid: boolean;
  error?: string;
  license_key?: {
    id?: number;
    key?: string;
    created_at?: string;
    expires_at?: string | null;
    status?: string;
    disabled?: boolean;
    activation_limit?: number | null;
    instances_count?: number | null;
  };
  instance?: Record<string, unknown> | null;
  meta?: {
    store_id?: number;
    order_id?: number;
    order_item_id?: number;
    product_id?: number;
    variant_id?: number;
    product_name?: string;
    variant_name?: string;
    user_name?: string;
    user_email?: string;
    test_mode?: boolean;
    customer_id?: number;
    subscription_id?: number | null;
  };
}

export interface LemonSqueezyLicenseValidationResult {
  valid: boolean;
  license?: LemonSqueezyLicenseKey;
  customerEmail?: string;
  customerName?: string;
  subscriptionId?: string;
  error?: string;
}

// ============================================================================
// WEBHOOK TYPES
// ============================================================================

export interface LemonSqueezyWebhookCreateInput {
  storeId: string;
  url: string;
  events: string[];
  secret: string;
  testMode?: boolean;
}

// ============================================================================
// NORMALIZED EVIDENCE
// ============================================================================

export interface LemonSqueezyEvidence {
  provider: 'lemonsqueezy';
  providerAccountRef: string;
  productRefs: string[];
  evidenceType: 'purchase' | 'subscription' | 'license';
  observedAt: string;
  rawRef: string;
  refunded: boolean;
  licenseKey?: string;
  email?: string;
}

export function isOrderValid(order: LemonSqueezyOrder): boolean {
  return !order.refunded && order.status !== 'refunded';
}

export function isSubscriptionActive(subscription: LemonSqueezySubscription): boolean {
  return ['active', 'on_trial', 'paused'].includes(subscription.status ?? '');
}

export function isLicenseKeyValid(license: LemonSqueezyLicenseKey): boolean {
  return !license.disabled && license.status !== 'expired' && license.status !== 'disabled';
}

export function normalizeOrderToEvidence(order: LemonSqueezyOrder): LemonSqueezyEvidence {
  return {
    provider: 'lemonsqueezy',
    providerAccountRef: order.customerId ?? order.userEmail ?? order.id,
    productRefs: [
      String(order.firstOrderItem?.variantId ?? order.firstOrderItem?.productId ?? ''),
    ].filter(Boolean),
    evidenceType: 'purchase',
    observedAt: order.createdAt ?? new Date().toISOString(),
    rawRef: order.id,
    refunded: order.refunded === true || order.status === 'refunded',
    email: order.userEmail ?? undefined,
  };
}

export function normalizeSubscriptionToEvidence(
  subscription: LemonSqueezySubscription
): LemonSqueezyEvidence {
  return {
    provider: 'lemonsqueezy',
    providerAccountRef: subscription.customerId ?? subscription.userEmail ?? subscription.id,
    productRefs: [String(subscription.variantId ?? subscription.productId ?? '')].filter(Boolean),
    evidenceType: 'subscription',
    observedAt: subscription.createdAt ?? new Date().toISOString(),
    rawRef: subscription.id,
    refunded: !isSubscriptionActive(subscription),
    email: subscription.userEmail ?? undefined,
  };
}

export function normalizeLicenseKeyToEvidence(
  license: LemonSqueezyLicenseKey
): LemonSqueezyEvidence {
  return {
    provider: 'lemonsqueezy',
    providerAccountRef: license.customerId ?? license.userEmail ?? license.id,
    productRefs: [String(license.variantId ?? license.productId ?? '')].filter(Boolean),
    evidenceType: 'license',
    observedAt: license.createdAt ?? new Date().toISOString(),
    rawRef: license.id,
    refunded: !isLicenseKeyValid(license),
    licenseKey: license.key ?? undefined,
    email: license.userEmail ?? undefined,
  };
}
