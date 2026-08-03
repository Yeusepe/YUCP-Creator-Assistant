import { LemonSqueezyApiClient } from '@yucp/providers';
import { timingSafeStringEqual } from '@yucp/shared';
import { normalizeEmail, sha256Hex } from '@yucp/shared/crypto';
import { api } from '../../../../convex/_generated/api';
import type { Auth } from '../auth';
import { getConvexClientFromUrl } from '../lib/convex';
import { decrypt } from '../lib/encrypt';
import { logger } from '../lib/logger';
import { loadRequestScoped, requestScopeKey } from '../lib/requestScope';
import {
  isWebhookContentLengthTooLarge,
  PayloadTooLargeError,
  readWebhookTextBody,
} from '../lib/webhookBody';
import { listDashboardProviderDisplays } from '../providers/display';
import { PURPOSES as LEMONSQUEEZY } from '../providers/lemonsqueezy/index';

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const idempotencyCache = new Map<
  string,
  { status: number; body: string; contentType: string; expiresAt: number }
>();

interface ProviderPlatformConfig {
  convexUrl: string;
  convexApiSecret: string;
  encryptionSecret: string;
}

type ConvexClient = ReturnType<typeof getConvexClientFromUrl>;

function newRequestId(): string {
  return crypto.randomUUID();
}

function jsonResponse(
  body: unknown,
  requestId: string,
  status = 200,
  extraHeaders?: HeadersInit
): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json');
  headers.set('X-Request-Id', requestId);
  return new Response(JSON.stringify(body), { status, headers });
}

function getIdempotencyCacheKey(request: Request, pathname: string): string | null {
  const key = request.headers.get('Idempotency-Key')?.trim();
  if (!key) return null;
  // Scope the key to the authenticated principal so two different tenants
  // sending the same Idempotency-Key on the same path cannot collide.
  // The Authorization header value is never persisted; it is only used here
  // as a cache-key discriminator.
  const authToken = request.headers.get('authorization') ?? 'anon';
  return `${request.method}:${pathname}:${authToken}:${key}`;
}

function getCachedIdempotentResponse(cacheKey: string, requestId: string): Response | null {
  const cached = idempotencyCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    idempotencyCache.delete(cacheKey);
    return null;
  }
  return new Response(cached.body, {
    status: cached.status,
    headers: {
      'Content-Type': cached.contentType,
      'X-Request-Id': requestId,
      'Idempotency-Replayed': 'true',
    },
  });
}

function storeIdempotentResponse(cacheKey: string | null, response: Response, body: string): void {
  if (!cacheKey) return;
  if (idempotencyCache.size >= 10_000) {
    // Evict the oldest entry (Map preserves insertion order).
    const oldestKey = idempotencyCache.keys().next().value;
    if (oldestKey !== undefined) {
      idempotencyCache.delete(oldestKey);
    }
  }
  idempotencyCache.set(cacheKey, {
    status: response.status,
    body,
    contentType: response.headers.get('Content-Type') ?? 'application/json',
    expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
  });
}

function parseIsoTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function hmacSha256(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function listAllOrders(client: LemonSqueezyApiClient, storeId: string) {
  const orders = [];
  let page = 1;
  while (true) {
    const result = await client.getOrders({ storeId, page, perPage: 100 });
    orders.push(...result.orders);
    if (!result.pagination.nextPage) break;
    page = result.pagination.nextPage;
  }
  return orders;
}

async function listAllSubscriptions(client: LemonSqueezyApiClient, storeId: string) {
  const subscriptions = [];
  let page = 1;
  while (true) {
    const result = await client.getSubscriptions({ storeId, page, perPage: 100 });
    subscriptions.push(...result.subscriptions);
    if (!result.pagination.nextPage) break;
    page = result.pagination.nextPage;
  }
  return subscriptions;
}

async function listAllLicenseKeys(client: LemonSqueezyApiClient, storeId: string) {
  const licenseKeys = [];
  let page = 1;
  while (true) {
    const result = await client.getLicenseKeys({ storeId, page, perPage: 100 });
    licenseKeys.push(...result.licenseKeys);
    if (!result.pagination.nextPage) break;
    page = result.pagination.nextPage;
  }
  return licenseKeys;
}

async function isTenantOwnedBySessionUser(
  request: Request,
  convex: ConvexClient,
  apiSecret: string,
  profileAuthUserId: string,
  sessionUserId: string
): Promise<boolean> {
  const profile = await loadRequestScoped(
    request,
    requestScopeKey('provider-platform:creator-profile', { authUserId: profileAuthUserId }),
    async () =>
      (await convex.query(api.creatorProfiles.getCreatorProfile, {
        apiSecret,
        authUserId: profileAuthUserId,
      })) as { authUserId?: string } | null
  );
  return !!profile && profile.authUserId === sessionUserId;
}

async function requireTenantAccess(
  auth: Auth,
  convex: ConvexClient,
  config: ProviderPlatformConfig,
  request: Request,
  authUserId: string
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const session = await auth.getSession(request);
  if (!session) {
    return {
      ok: false,
      response: jsonResponse({ error: 'Authentication required' }, newRequestId(), 401),
    };
  }

  const owned = await isTenantOwnedBySessionUser(
    request,
    convex,
    config.convexApiSecret,
    authUserId,
    session.user.id
  );
  if (!owned) {
    return {
      ok: false,
      response: jsonResponse({ error: 'Forbidden' }, newRequestId(), 403),
    };
  }

  return { ok: true };
}

// biome-ignore lint/correctness/noUnusedVariables: retained for the webhook support boundary after removing dead management routes
async function requireConnectionAccess(
  auth: Auth,
  convex: ConvexClient,
  config: ProviderPlatformConfig,
  request: Request,
  connectionId: string
) {
  const connection = await loadRequestScoped(
    request,
    requestScopeKey('provider-platform:connection-admin', { connectionId }),
    async () =>
      convex.query(api.providerPlatform.getProviderConnectionAdmin, {
        apiSecret: config.convexApiSecret,
        providerConnectionId: connectionId,
      })
  );

  if (!connection) {
    return {
      ok: false as const,
      response: jsonResponse({ error: 'Connection not found' }, newRequestId(), 404),
    };
  }

  const access = await requireTenantAccess(auth, convex, config, request, connection.authUserId);
  if (!access.ok) {
    return access;
  }

  return { ok: true as const, connection };
}

function resolveCatalogMatch(
  mappings: Array<{
    catalogProductId?: string;
    localProductId?: string;
    externalVariantId?: string;
    externalProductId?: string;
  }>,
  catalogProducts: Array<{ _id: string; productId: string; providerProductRef: string }>,
  providerRefs: Array<string | undefined | null>
) {
  const refs = providerRefs.filter((value): value is string => Boolean(value));
  for (const ref of refs) {
    const mapping = mappings.find(
      (entry) => entry.externalVariantId === ref || entry.externalProductId === ref
    );
    if (mapping?.catalogProductId || mapping?.localProductId) {
      return { catalogProductId: mapping.catalogProductId, productId: mapping.localProductId };
    }
  }
  for (const ref of refs) {
    const catalog = catalogProducts.find((entry) => entry.providerProductRef === ref);
    if (catalog) return { catalogProductId: catalog._id, productId: catalog.productId };
  }
  return { catalogProductId: undefined, productId: undefined };
}

async function buildLemonClientForConnection(
  request: Request,
  convex: ConvexClient,
  config: ProviderPlatformConfig,
  authUserId: string
) {
  const secrets = await loadRequestScoped(
    request,
    requestScopeKey('provider-platform:connection-backfill', {
      authUserId,
      provider: 'lemonsqueezy',
    }),
    async () =>
      convex.query(api.providerConnections.getConnectionForBackfill, {
        apiSecret: config.convexApiSecret,
        authUserId,
        provider: 'lemonsqueezy',
      })
  );
  const encryptedApiToken = secrets?.credentials.api_token;
  if (!encryptedApiToken) throw new Error('Lemon Squeezy API token not configured');
  const apiToken = await decrypt(
    encryptedApiToken,
    config.encryptionSecret,
    LEMONSQUEEZY.credential
  );
  return new LemonSqueezyApiClient({ apiToken });
}

// biome-ignore lint/correctness/noUnusedVariables: retained for the webhook support boundary after removing dead management routes
async function syncLemonCatalog(
  request: Request,
  convex: ConvexClient,
  config: ProviderPlatformConfig,
  connection: { connectionId: string; authUserId: string; externalShopId?: string }
) {
  const client = await buildLemonClientForConnection(
    request,
    convex,
    config,
    connection.authUserId
  );
  if (!connection.externalShopId) throw new Error('No Lemon Squeezy store selected');

  const [catalogProducts, products] = await Promise.all([
    convex.query(api.providerPlatform.listCatalogProductsForTenant, {
      apiSecret: config.convexApiSecret,
      authUserId: connection.authUserId,
    }),
    client.getAllProducts(connection.externalShopId),
  ]);

  let variantsSynced = 0;
  for (const product of products) {
    const variants = await client.getAllVariants(product.id);
    if (variants.length === 0) {
      const match = catalogProducts.find(
        (entry: { provider: string; providerProductRef: string }) =>
          entry.provider === 'lemonsqueezy' && entry.providerProductRef === product.id
      );
      await convex.mutation(api.providerPlatform.upsertCatalogMapping, {
        apiSecret: config.convexApiSecret,
        authUserId: connection.authUserId,
        providerConnectionId: connection.connectionId,
        providerKey: 'lemonsqueezy',
        catalogProductId: match?._id,
        localProductId: match?.productId,
        externalStoreId: connection.externalShopId,
        externalProductId: product.id,
        displayName: product.name,
        metadata: { product },
      });
      continue;
    }

    for (const variant of variants) {
      const match = catalogProducts.find(
        (entry: { provider: string; providerProductRef: string }) =>
          entry.provider === 'lemonsqueezy' &&
          (entry.providerProductRef === variant.id || entry.providerProductRef === product.id)
      );
      await convex.mutation(api.providerPlatform.upsertCatalogMapping, {
        apiSecret: config.convexApiSecret,
        authUserId: connection.authUserId,
        providerConnectionId: connection.connectionId,
        providerKey: 'lemonsqueezy',
        catalogProductId: match?._id,
        localProductId: match?.productId,
        externalStoreId: connection.externalShopId,
        externalProductId: product.id,
        externalVariantId: variant.id,
        displayName: `${product.name} / ${variant.name}`,
        metadata: { product, variant },
      });
      variantsSynced += 1;
    }
  }

  await convex.mutation(api.providerPlatform.updateProviderConnectionState, {
    apiSecret: config.convexApiSecret,
    providerConnectionId: connection.connectionId,
    lastSyncAt: Date.now(),
    status: 'active',
  });
  await convex.mutation(api.providerConnections.upsertConnectionCapability, {
    apiSecret: config.convexApiSecret,
    authUserId: connection.authUserId,
    providerConnectionId: connection.connectionId,
    capabilityKey: 'catalog_sync',
    status: 'active',
  });

  return { productsSynced: products.length, variantsSynced };
}

// biome-ignore lint/correctness/noUnusedVariables: retained for the webhook support boundary after removing dead management routes
async function reconcileLemonConnection(
  request: Request,
  convex: ConvexClient,
  config: ProviderPlatformConfig,
  connection: { connectionId: string; authUserId: string; externalShopId?: string }
) {
  const client = await buildLemonClientForConnection(
    request,
    convex,
    config,
    connection.authUserId
  );
  if (!connection.externalShopId) throw new Error('No Lemon Squeezy store selected');

  const [mappings, catalogProducts, orders, subscriptions, licenseKeys] = await Promise.all([
    convex.query(api.providerPlatform.listCatalogMappingsForConnection, {
      apiSecret: config.convexApiSecret,
      providerConnectionId: connection.connectionId,
    }),
    convex.query(api.providerPlatform.listCatalogProductsForTenant, {
      apiSecret: config.convexApiSecret,
      authUserId: connection.authUserId,
    }),
    listAllOrders(client, connection.externalShopId),
    listAllSubscriptions(client, connection.externalShopId),
    listAllLicenseKeys(client, connection.externalShopId),
  ]);

  for (const order of orders) {
    const normalizedEmail = order.userEmail ? normalizeEmail(order.userEmail) : undefined;
    const emailHash = normalizedEmail ? await sha256Hex(normalizedEmail) : undefined;
    const match = resolveCatalogMatch(mappings, catalogProducts, [
      order.firstOrderItem?.variantId ? String(order.firstOrderItem.variantId) : undefined,
      order.firstOrderItem?.productId ? String(order.firstOrderItem.productId) : undefined,
    ]);
    const transactionId = await convex.mutation(api.providerPlatform.upsertProviderTransaction, {
      apiSecret: config.convexApiSecret,
      authUserId: connection.authUserId,
      providerConnectionId: connection.connectionId,
      providerKey: 'lemonsqueezy',
      externalTransactionId: order.id,
      externalOrderNumber: order.orderNumber ? String(order.orderNumber) : undefined,
      externalOrderItemId: order.firstOrderItem?.id ? String(order.firstOrderItem.id) : undefined,
      externalStoreId: order.storeId,
      externalProductId: order.firstOrderItem?.productId
        ? String(order.firstOrderItem.productId)
        : undefined,
      externalVariantId: order.firstOrderItem?.variantId
        ? String(order.firstOrderItem.variantId)
        : undefined,
      externalCustomerId: order.customerId ?? undefined,
      customerEmail: normalizedEmail,
      customerEmailHash: emailHash,
      currency: order.currency ?? undefined,
      amountSubtotal: order.subtotal ?? undefined,
      amountTotal: order.total ?? undefined,
      status: order.refunded ? 'refunded' : 'paid',
      purchasedAt: parseIsoTimestamp(order.createdAt),
      refundedAt: parseIsoTimestamp(order.refundedAt),
      metadata: { order },
    });
    const subjectId = emailHash
      ? await convex.query(api.providerPlatform.resolveTenantSubjectByEmailHash, {
          apiSecret: config.convexApiSecret,
          authUserId: connection.authUserId,
          emailHash,
        })
      : undefined;
    await convex.mutation(api.providerPlatform.upsertEntitlementEvidence, {
      apiSecret: config.convexApiSecret,
      authUserId: connection.authUserId,
      subjectId,
      providerKey: 'lemonsqueezy',
      providerConnectionId: connection.connectionId,
      transactionId,
      sourceReference: `lemonsqueezy:order:${order.id}`,
      evidenceType: 'purchase.recorded',
      status: order.refunded ? 'revoked' : 'active',
      productId: match.productId,
      catalogProductId: match.catalogProductId,
      observedAt: parseIsoTimestamp(order.updatedAt) ?? Date.now(),
      metadata: { order },
    });
    if (subjectId && match.productId && !order.refunded) {
      await convex.mutation(api.entitlements.grantEntitlement, {
        apiSecret: config.convexApiSecret,
        authUserId: connection.authUserId,
        subjectId,
        productId: match.productId,
        catalogProductId: match.catalogProductId,
        evidence: {
          provider: 'lemonsqueezy',
          sourceReference: `lemonsqueezy:order:${order.id}`,
          purchasedAt: parseIsoTimestamp(order.createdAt),
          amount: order.total ?? undefined,
          currency: order.currency ?? undefined,
          rawEvidence: order,
        },
      });
    } else if (order.refunded && subjectId) {
      await convex.mutation(api.entitlements.revokeEntitlementBySourceRef, {
        apiSecret: config.convexApiSecret,
        authUserId: connection.authUserId,
        subjectId,
        sourceReference: `lemonsqueezy:order:${order.id}`,
        reason: 'refunded',
      });
    }
  }

  for (const subscription of subscriptions) {
    const normalizedEmail = subscription.userEmail
      ? normalizeEmail(subscription.userEmail)
      : undefined;
    const emailHash = normalizedEmail ? await sha256Hex(normalizedEmail) : undefined;
    const match = resolveCatalogMatch(mappings, catalogProducts, [
      subscription.variantId ? String(subscription.variantId) : undefined,
      subscription.productId ? String(subscription.productId) : undefined,
    ]);
    await convex.mutation(api.providerPlatform.upsertProviderMembership, {
      apiSecret: config.convexApiSecret,
      authUserId: connection.authUserId,
      providerConnectionId: connection.connectionId,
      providerKey: 'lemonsqueezy',
      externalMembershipId: subscription.id,
      externalTransactionId: subscription.orderId ?? undefined,
      externalProductId: subscription.productId ? String(subscription.productId) : undefined,
      externalVariantId: subscription.variantId ? String(subscription.variantId) : undefined,
      externalCustomerId: subscription.customerId ?? undefined,
      customerEmail: normalizedEmail,
      customerEmailHash: emailHash,
      status:
        subscription.status === 'cancelled'
          ? 'cancelled'
          : subscription.status === 'expired'
            ? 'expired'
            : subscription.status === 'paused'
              ? 'paused'
              : subscription.status === 'on_trial'
                ? 'trialing'
                : 'active',
      startedAt: parseIsoTimestamp(subscription.createdAt),
      renewsAt: parseIsoTimestamp(subscription.renewsAt),
      endsAt: parseIsoTimestamp(subscription.endsAt),
      cancelledAt: subscription.cancelled ? parseIsoTimestamp(subscription.updatedAt) : undefined,
      metadata: {
        subscription,
        productId: match.productId,
        catalogProductId: match.catalogProductId,
      },
    });
  }

  for (const license of licenseKeys) {
    const normalizedEmail = license.userEmail ? normalizeEmail(license.userEmail) : undefined;
    const emailHash = normalizedEmail ? await sha256Hex(normalizedEmail) : undefined;
    await convex.mutation(api.providerPlatform.upsertProviderLicense, {
      apiSecret: config.convexApiSecret,
      authUserId: connection.authUserId,
      providerConnectionId: connection.connectionId,
      providerKey: 'lemonsqueezy',
      externalLicenseId: license.id,
      externalTransactionId: license.orderId ?? undefined,
      externalProductId: license.productId ? String(license.productId) : undefined,
      externalVariantId: license.variantId ? String(license.variantId) : undefined,
      externalCustomerId: license.customerId ?? undefined,
      customerEmail: normalizedEmail,
      customerEmailHash: emailHash,
      licenseKeyHash: license.key ? await sha256Hex(license.key) : undefined,
      shortKey: license.keyShort ?? undefined,
      status:
        license.disabled || license.status === 'disabled'
          ? 'disabled'
          : license.status === 'expired'
            ? 'expired'
            : 'active',
      issuedAt: parseIsoTimestamp(license.createdAt),
      expiresAt: parseIsoTimestamp(license.expiresAt),
      lastValidatedAt: Date.now(),
      metadata: { license },
    });
  }

  await convex.mutation(api.providerPlatform.updateProviderConnectionState, {
    apiSecret: config.convexApiSecret,
    providerConnectionId: connection.connectionId,
    lastHealthcheckAt: Date.now(),
    status: 'active',
  });

  return {
    orders: orders.length,
    subscriptions: subscriptions.length,
    licenseKeys: licenseKeys.length,
  };
}

export function createProviderPlatformRoutes(config: ProviderPlatformConfig) {
  const convex = getConvexClientFromUrl(config.convexUrl);

  async function handleProviderWebhook(
    request: Request,
    requestId: string,
    providerKey: string,
    connectionId: string
  ) {
    if (isWebhookContentLengthTooLarge(request)) {
      logger.warn('Lemon webhook rejected oversized payload', { connectionId, providerKey });
      return jsonResponse({ error: 'Payload too large' }, requestId, 413);
    }

    if (providerKey !== 'lemonsqueezy')
      return jsonResponse(
        { error: 'Canonical webhooks are only implemented for lemonsqueezy in phase 1' },
        requestId,
        404
      );
    const connection = await loadRequestScoped(
      request,
      requestScopeKey('provider-platform:connection-admin', { connectionId }),
      async () =>
        convex.query(api.providerPlatform.getProviderConnectionAdmin, {
          apiSecret: config.convexApiSecret,
          providerConnectionId: connectionId,
        })
    );
    if (!connection) return jsonResponse({ error: 'Connection not found' }, requestId, 404);

    const secrets = await loadRequestScoped(
      request,
      requestScopeKey('provider-platform:connection-backfill', {
        authUserId: connection.authUserId,
        provider: 'lemonsqueezy',
      }),
      async () =>
        convex.query(api.providerConnections.getConnectionForBackfill, {
          apiSecret: config.convexApiSecret,
          authUserId: connection.authUserId,
          provider: 'lemonsqueezy',
        })
    );
    const encryptedWebhookSecret =
      connection.remoteWebhookSecretRef ?? secrets?.webhookSecretRef ?? null;
    if (!encryptedWebhookSecret)
      return jsonResponse({ error: 'Webhook secret not configured' }, requestId, 409);

    let rawBody: string;
    try {
      rawBody = await readWebhookTextBody(request);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        logger.warn('Lemon webhook rejected oversized payload', { connectionId, providerKey });
        return jsonResponse({ error: 'Payload too large' }, requestId, 413);
      }
      throw error;
    }
    const webhookSecret = await decrypt(
      encryptedWebhookSecret,
      config.encryptionSecret,
      LEMONSQUEEZY.webhookSecret
    );
    const signature = request.headers.get('x-signature')?.trim() ?? '';
    const expected = await hmacSha256(webhookSecret, rawBody);
    if (!signature || !timingSafeStringEqual(expected, signature)) {
      logger.warn('Lemon webhook rejected', {
        connectionId,
        authUserId: connection.authUserId,
        hasSignature: !!signature,
        signatureLength: signature.length,
        expectedLength: expected.length,
        secretSource: connection.remoteWebhookSecretRef ? 'remoteWebhookSecretRef' : 'credential',
      });
      return jsonResponse({ error: 'Forbidden' }, requestId, 403);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      logger.warn('Lemon webhook rejected malformed payload', { connectionId });
      return jsonResponse({ error: 'Bad Request' }, requestId, 400);
    }
    const meta = (payload.meta ?? {}) as Record<string, unknown>;
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const eventType = typeof meta.event_name === 'string' ? meta.event_name : 'unknown';
    const providerEventId = `${String(data.id ?? 'unknown')}:${eventType}`;
    const result = await convex.mutation(api.webhookIngestion.insertWebhookEvent, {
      apiSecret: config.convexApiSecret,
      authUserId: connection.authUserId,
      provider: 'lemonsqueezy',
      providerKey: 'lemonsqueezy',
      providerConnectionId: connection.connectionId,
      providerEventId,
      eventType,
      rawPayload: payload,
      signatureValid: true,
      verificationMethod: 'hmac',
    });
    await convex.mutation(api.providerPlatform.updateProviderConnectionState, {
      apiSecret: config.convexApiSecret,
      providerConnectionId: connection.connectionId,
      lastWebhookAt: Date.now(),
      lastHealthcheckAt: Date.now(),
      status: 'active',
    });
    if (process.env.NODE_ENV !== 'production') {
      logger.info('Webhook accepted', {
        provider: 'lemonsqueezy',
        connectionId,
        eventType,
        providerEventId,
        duplicate: result.duplicate,
      });
    }
    return jsonResponse({ success: true, duplicate: result.duplicate }, requestId, 202);
  }

  return {
    async handleRequest(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const requestId = newRequestId();

      if (request.method === 'GET' && url.pathname === '/api/providers') {
        const providers = listDashboardProviderDisplays();
        return new Response(JSON.stringify(providers), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const cacheKey = getIdempotencyCacheKey(request, url.pathname);
      const cached = cacheKey ? getCachedIdempotentResponse(cacheKey, requestId) : null;
      if (cached) return cached;

      let response: Response | null = null;
      try {
        const webhookMatch = url.pathname.match(/^\/v1\/webhooks\/([^/]+)\/([^/]+)$/);
        if (!response && request.method === 'POST' && webhookMatch)
          response = await handleProviderWebhook(
            request,
            requestId,
            decodeURIComponent(webhookMatch[1] ?? ''),
            decodeURIComponent(webhookMatch[2] ?? '')
          );
      } catch (error) {
        logger.error('Provider platform route failed', {
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        });
        response = jsonResponse({ error: 'An internal error occurred' }, requestId, 500);
      }

      if (!response) return null;
      const body = await response.clone().text();
      storeIdempotentResponse(cacheKey, response, body);
      return new Response(body, { status: response.status, headers: response.headers });
    },
  };
}
