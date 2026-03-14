/**
 * Webhook signature test helpers.
 *
 * Each helper mirrors the exact algorithm used by the corresponding production
 * webhook handler so tests can generate valid (or deliberately invalid)
 * request payloads without duplicating crypto logic across test files.
 *
 * Algorithms (confirmed from source):
 *  - Gumroad:       form-encoded body, NO signature — security via routeId
 *  - Jinxxy:        HMAC-SHA256(secret, rawBody) → lowercase hex in `x-signature` header
 *  - LemonSqueezy:  HMAC-SHA256(secret, rawBody) → lowercase hex in `x-signature` header
 *  - Payhip:        SHA256(apiKey) → lowercase hex as `signature` field in JSON body
 */

const encoder = new TextEncoder();

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return bufToHex(sig);
}

// ---------------------------------------------------------------------------
// Gumroad — form-encoded body, no signature
// ---------------------------------------------------------------------------

export interface GumroadSaleOptions {
  saleId: string;
  productId?: string;
  email?: string;
  refunded?: boolean;
  /** ISO timestamp; defaults to now */
  saleTimestamp?: string;
}

/**
 * Returns a URLSearchParams representing a Gumroad Ping webhook body.
 * Gumroad has no HMAC — the routeId is the only security mechanism.
 */
export function gumroadSalePayload(opts: GumroadSaleOptions): URLSearchParams {
  const params = new URLSearchParams();
  params.set('sale_id', opts.saleId);
  params.set('refunded', String(opts.refunded ?? false));
  params.set('sale_timestamp', opts.saleTimestamp ?? new Date().toISOString());
  if (opts.productId !== undefined) params.set('product_id', opts.productId);
  if (opts.email !== undefined) params.set('email', opts.email);
  return params;
}

// ---------------------------------------------------------------------------
// Jinxxy — HMAC-SHA256 in `x-signature` header
// ---------------------------------------------------------------------------

/**
 * Returns the lowercase-hex HMAC-SHA256 signature for a Jinxxy webhook body.
 * Pass the result as the `x-signature` header value.
 * No `sha256=` prefix (the handler strips it if present, but we omit it).
 */
export async function signJinxxy(secret: string, body: string): Promise<string> {
  return hmacSha256Hex(secret, body);
}

export interface JinxxyOrderOptions {
  eventId: string;
  /** defaults to 'order.completed' */
  eventType?: string;
  /** ISO timestamp; defaults to now */
  createdAt?: string;
  data?: Record<string, unknown>;
}

/**
 * Returns a JSON string for a Jinxxy webhook payload.
 * Sign the returned string with {@link signJinxxy} to get the header value.
 */
export function jinxxyOrderPayload(opts: JinxxyOrderOptions): string {
  return JSON.stringify({
    event_id: opts.eventId,
    event_type: opts.eventType ?? 'order.completed',
    created_at: opts.createdAt ?? new Date().toISOString(),
    ...(opts.data ?? {}),
  });
}

// ---------------------------------------------------------------------------
// LemonSqueezy — HMAC-SHA256 in `x-signature` header
// ---------------------------------------------------------------------------

/**
 * Returns the lowercase-hex HMAC-SHA256 signature for a LemonSqueezy webhook body.
 * Pass the result as the `x-signature` header value.
 */
export async function signLemonSqueezy(secret: string, body: string): Promise<string> {
  return hmacSha256Hex(secret, body);
}

export interface LemonSqueezyOrderOptions {
  orderId: string;
  /** defaults to 'order_created' */
  eventName?: string;
  /** defaults to 'paid' */
  orderStatus?: string;
  email?: string;
  storeId?: number;
}

/**
 * Returns a JSON string for a LemonSqueezy webhook payload.
 * Sign the returned string with {@link signLemonSqueezy} to get the header value.
 */
export function lemonSqueezyOrderPayload(opts: LemonSqueezyOrderOptions): string {
  return JSON.stringify({
    meta: {
      event_name: opts.eventName ?? 'order_created',
    },
    data: {
      id: opts.orderId,
      attributes: {
        status: opts.orderStatus ?? 'paid',
        ...(opts.email !== undefined ? { user_email: opts.email } : {}),
        ...(opts.storeId !== undefined ? { store_id: opts.storeId } : {}),
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Payhip — SHA256(apiKey) as `signature` field in JSON body
// ---------------------------------------------------------------------------

/**
 * Returns the lowercase-hex SHA256 hash of the Payhip API key.
 * This is a static hash (not HMAC of the body) used as the `signature` field.
 */
export async function hashPayhip(apiKey: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(apiKey));
  return bufToHex(buf);
}

export interface PayhipPaidOptions {
  transactionId: string;
  email?: string;
  apiKey: string;
  productId?: string;
  productKey?: string;
  /** ISO timestamp; defaults to now */
  createdAt?: string;
  refunded?: boolean;
}

/**
 * Returns a JSON string for a Payhip webhook payload with the `signature`
 * field already set to SHA256(apiKey).
 */
export async function payhipPaidPayload(opts: PayhipPaidOptions): Promise<string> {
  const signature = await hashPayhip(opts.apiKey);
  const payload: Record<string, unknown> = {
    id: opts.transactionId,
    type: opts.refunded ? 'refund' : 'paid',
    signature,
    created_at: opts.createdAt ?? new Date().toISOString(),
  };
  if (opts.email !== undefined) payload.email = opts.email;
  if (opts.productId !== undefined) payload.product_id = opts.productId;
  if (opts.productKey !== undefined) payload.product_key = opts.productKey;
  return JSON.stringify(payload);
}
