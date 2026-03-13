import { randomBytes } from 'node:crypto';
import { LemonSqueezyApiClient } from '@yucp/providers';
import { createLogger, getProviderDescriptor } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import type { Auth } from '../auth';
import { SETUP_SESSION_COOKIE, getCookieValue } from '../lib/browserSessions';
import { getConvexClientFromUrl } from '../lib/convex';
import { decrypt, encrypt } from '../lib/encrypt';
import { resolveSetupSession } from '../lib/setupSession';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const idempotencyCache = new Map<
  string,
  { status: number; body: string; contentType: string; expiresAt: number }
>();

const LEMON_WEBHOOK_EVENTS = [
  'order_created',
  'order_refunded',
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'subscription_resumed',
  'subscription_expired',
  'subscription_paused',
  'subscription_unpaused',
  'subscription_payment_success',
  'subscription_payment_failed',
  'license_key_created',
  'license_key_updated',
] as const;

interface ProviderPlatformConfig {
  apiBaseUrl: string;
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
  return `${request.method}:${pathname}:${key}`;
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
  idempotencyCache.set(cacheKey, {
    status: response.status,
    body,
    contentType: response.headers.get('Content-Type') ?? 'application/json',
    expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
  });
}

async function jsonFromRequest<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a.toLowerCase());
  const bBytes = new TextEncoder().encode(b.toLowerCase());
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i += 1) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
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
  convex: ConvexClient,
  apiSecret: string,
  authUserId: string,
  authUserId: string
): Promise<boolean> {
  const tenant = (await convex.query(api.creatorProfiles.getCreatorProfile, {
    apiSecret,
    authUserId,
  })) as { ownerAuthUserId?: string } | null;
  return tenant?.ownerAuthUserId === authUserId;
}

async function resolveSetupSessionFromRequest(request: Request, encryptionSecret: string) {
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const cookieToken = getCookieValue(request, SETUP_SESSION_COOKIE);
  const token = bearerToken ?? cookieToken;
  if (!token) return null;
  return resolveSetupSession(token, encryptionSecret);
}

async function requireTenantAccess(
  auth: Auth,
  convex: ConvexClient,
  config: ProviderPlatformConfig,
  request: Request,
  authUserId: string
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const setupSession = await resolveSetupSessionFromRequest(request, config.encryptionSecret);
  if (setupSession) {
    const session = await auth.getSession(request);
    const authDiscordUserId = await auth.getDiscordUserId(request);
    if (!session || !authDiscordUserId) {
      return {
        ok: false,
        response: jsonResponse({ error: 'Authentication required' }, newRequestId(), 401),
      };
    }
    if (authDiscordUserId !== setupSession.discordUserId || setupSession.authUserId !== authUserId) {
      return {
        ok: false,
        response: jsonResponse({ error: 'Forbidden' }, newRequestId(), 403),
      };
    }
    return { ok: true };
  }

  const session = await auth.getSession(request);
  if (!session) {
    return {
      ok: false,
      response: jsonResponse({ error: 'Authentication required' }, newRequestId(), 401),
    };
  }

  const owned = await isTenantOwnedBySessionUser(
    convex,
    config.convexApiSecret,
    session.user.id,
    authUserId
  );
  if (!owned) {
    return {
      ok: false,
      response: jsonResponse({ error: 'Forbidden' }, newRequestId(), 403),
    };
  }

  return { ok: true };
}

async function requireConnectionAccess(
  auth: Auth,
  convex: ConvexClient,
  config: ProviderPlatformConfig,
  request: Request,
  connectionId: string
) {
  const connection = await convex.query(api.providerPlatform.getProviderConnectionAdmin, {
    apiSecret: config.convexApiSecret,
    providerConnectionId: connectionId,
  });

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
  convex: ConvexClient,
  config: ProviderPlatformConfig,
  authUserId: string
) {
  const secrets = await convex.query(api.providerConnections.getConnectionForBackfill, {
    apiSecret: config.convexApiSecret,
    authUserId,
    provider: 'lemonsqueezy',
  });
  const encryptedApiToken = secrets?.lemonApiTokenEncrypted;
  if (!encryptedApiToken) throw new Error('Lemon Squeezy API token not configured');
  const apiToken = await decrypt(encryptedApiToken, config.encryptionSecret);
  return new LemonSqueezyApiClient({ apiToken });
}

async function syncLemonCatalog(
  convex: ConvexClient,
  config: ProviderPlatformConfig,
  connection: { connectionId: string; authUserId: string; externalShopId?: string }
) {
  const client = await buildLemonClientForConnection(convex, config, connection.authUserId);
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

async function reconcileLemonConnection(
  convex: ConvexClient,
  config: ProviderPlatformConfig,
  connection: { connectionId: string; authUserId: string; externalShopId?: string }
) {
  const client = await buildLemonClientForConnection(convex, config, connection.authUserId);
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

export function createProviderPlatformRoutes(auth: Auth, config: ProviderPlatformConfig) {
  const convex = getConvexClientFromUrl(config.convexUrl);

  async function handleCreateProviderConnection(
    request: Request,
    requestId: string,
    authUserId: string
  ) {
    const access = await requireTenantAccess(auth, convex, config, request, authUserId);
    if (!access.ok) return access.response;
    const body = await jsonFromRequest<{
      providerKey: string;
      label?: string;
      authMode?: string;
      externalShopId?: string;
      externalShopName?: string;
      metadata?: unknown;
    }>(request);
    if (!getProviderDescriptor(body.providerKey)) {
      return jsonResponse({ error: 'Unknown provider' }, requestId, 400);
    }
    const connectionId = await convex.mutation(api.providerConnections.createProviderConnection, {
      apiSecret: config.convexApiSecret,
      authUserId,
      providerKey: body.providerKey,
      label: body.label,
      authMode: body.authMode,
      externalShopId: body.externalShopId,
      externalShopName: body.externalShopName,
      metadata: body.metadata,
    });
    return jsonResponse(
      { connectionId, providerKey: body.providerKey, status: 'pending' },
      requestId,
      201
    );
  }

  async function handlePutProviderCredentials(
    request: Request,
    requestId: string,
    connectionId: string
  ) {
    const access = await requireConnectionAccess(auth, convex, config, request, connectionId);
    if (!access.ok) return access.response;
    const { connection } = access;
    const body = await jsonFromRequest<{
      credentials?: Array<{
        credentialKey: string;
        kind: string;
        value?: string;
        metadata?: unknown;
      }>;
      apiToken?: string;
      storeId?: string;
      webhookSecret?: string;
      testMode?: boolean;
    }>(request);

    if (connection.providerKey !== 'lemonsqueezy') {
      const credentials = Array.isArray(body.credentials) ? body.credentials : [];
      if (credentials.length === 0)
        return jsonResponse({ error: 'credentials are required' }, requestId, 400);
      for (const credential of credentials) {
        await convex.mutation(api.providerConnections.putProviderCredential, {
          apiSecret: config.convexApiSecret,
          authUserId: connection.authUserId,
          providerConnectionId: connection.connectionId,
          credentialKey: credential.credentialKey,
          kind: credential.kind,
          encryptedValue: credential.value
            ? await encrypt(credential.value, config.encryptionSecret)
            : undefined,
          metadata: credential.metadata,
        });
      }
      await convex.mutation(api.providerPlatform.updateProviderConnectionState, {
        apiSecret: config.convexApiSecret,
        providerConnectionId: connection.connectionId,
        status: 'active',
        lastHealthcheckAt: Date.now(),
      });
      return jsonResponse({ success: true }, requestId);
    }

    const apiToken = String(body.apiToken ?? '').trim();
    if (!apiToken) return jsonResponse({ error: 'apiToken is required' }, requestId, 400);

    const client = new LemonSqueezyApiClient({ apiToken });
    const storesResult = await client.getStores(1, 100);
    let selectedStore = storesResult.stores.find((store) => store.id === body.storeId);
    if (!selectedStore) {
      if (storesResult.stores.length === 1) selectedStore = storesResult.stores[0];
      else {
        return jsonResponse(
          {
            error: 'storeId is required when multiple Lemon Squeezy stores are available',
            availableStores: storesResult.stores.map((store) => ({
              id: store.id,
              name: store.name,
              slug: store.slug,
            })),
          },
          requestId,
          409
        );
      }
    }
    if (!selectedStore)
      return jsonResponse({ error: 'No Lemon Squeezy stores found' }, requestId, 422);

    const webhookSecret =
      String(body.webhookSecret ?? '').trim() || crypto.randomUUID().replace(/-/g, '');
    const webhookUrl = `${config.apiBaseUrl.replace(/\/$/, '')}/v1/webhooks/lemonsqueezy/${connection.connectionId}`;
    const webhook = await client.createWebhook({
      storeId: selectedStore.id,
      url: webhookUrl,
      events: [...LEMON_WEBHOOK_EVENTS],
      secret: webhookSecret,
      testMode: Boolean(body.testMode ?? selectedStore.testMode ?? false),
    });
    const encryptedApiToken = await encrypt(apiToken, config.encryptionSecret);
    const encryptedWebhookSecret = await encrypt(webhookSecret, config.encryptionSecret);

    for (const credential of [
      {
        credentialKey: 'api_token',
        kind: 'api_token',
        encryptedValue: encryptedApiToken,
        metadata: { storeId: selectedStore.id },
      },
      {
        credentialKey: 'webhook_secret',
        kind: 'webhook_secret',
        encryptedValue: encryptedWebhookSecret,
        metadata: { webhookId: webhook.id },
      },
      {
        credentialKey: 'store_selector',
        kind: 'store_selector',
        encryptedValue: undefined,
        metadata: {
          storeId: selectedStore.id,
          storeName: selectedStore.name,
          slug: selectedStore.slug,
        },
      },
      {
        credentialKey: 'remote_webhook',
        kind: 'remote_webhook',
        encryptedValue: undefined,
        metadata: { webhookId: webhook.id, events: webhook.events, url: webhook.url },
      },
    ] as const) {
      await convex.mutation(api.providerConnections.putProviderCredential, {
        apiSecret: config.convexApiSecret,
        authUserId: connection.authUserId,
        providerConnectionId: connection.connectionId,
        credentialKey: credential.credentialKey,
        kind: credential.kind,
        encryptedValue: credential.encryptedValue,
        metadata: credential.metadata,
      });
    }

    await convex.mutation(api.providerPlatform.updateProviderConnectionState, {
      apiSecret: config.convexApiSecret,
      providerConnectionId: connection.connectionId,
      status: 'active',
      authMode: 'api_token',
      externalShopId: selectedStore.id,
      externalShopName: selectedStore.name,
      webhookConfigured: true,
      webhookEndpoint: webhookUrl,
      remoteWebhookId: webhook.id,
      remoteWebhookSecretRef: encryptedWebhookSecret,
      lastHealthcheckAt: Date.now(),
      testMode: Boolean(body.testMode ?? selectedStore.testMode ?? false),
      metadata: { store: selectedStore, webhookId: webhook.id },
    });

    for (const capabilityKey of [
      'catalog_sync',
      'managed_webhooks',
      'webhooks',
      'reconciliation',
      'license_verification',
      'orders',
      'refunds',
      'subscriptions',
    ]) {
      await convex.mutation(api.providerConnections.upsertConnectionCapability, {
        apiSecret: config.convexApiSecret,
        authUserId: connection.authUserId,
        providerConnectionId: connection.connectionId,
        capabilityKey,
        status: 'active',
      });
    }

    const sync = await syncLemonCatalog(convex, config, {
      connectionId: connection.connectionId,
      authUserId: connection.authUserId,
      externalShopId: selectedStore.id,
    });
    return jsonResponse(
      {
        success: true,
        providerKey: 'lemonsqueezy',
        store: selectedStore,
        webhook: { id: webhook.id, url: webhook.url, events: webhook.events },
        sync,
      },
      requestId
    );
  }

  async function handleCatalogSyncJob(request: Request, requestId: string, connectionId: string) {
    const access = await requireConnectionAccess(auth, convex, config, request, connectionId);
    if (!access.ok) return access.response;
    if (access.connection.providerKey !== 'lemonsqueezy')
      return jsonResponse(
        { error: 'Catalog sync is only implemented for lemonsqueezy in phase 1' },
        requestId,
        422
      );
    const stats = await syncLemonCatalog(convex, config, {
      connectionId: access.connection.connectionId,
      authUserId: access.connection.authUserId,
      externalShopId: access.connection.externalShopId,
    });
    return jsonResponse({ success: true, stats }, requestId, 202);
  }

  async function handleReconciliationJob(
    request: Request,
    requestId: string,
    connectionId: string
  ) {
    const access = await requireConnectionAccess(auth, convex, config, request, connectionId);
    if (!access.ok) return access.response;
    if (access.connection.providerKey !== 'lemonsqueezy')
      return jsonResponse(
        { error: 'Reconciliation is only implemented for lemonsqueezy in phase 1' },
        requestId,
        422
      );
    const stats = await reconcileLemonConnection(convex, config, {
      connectionId: access.connection.connectionId,
      authUserId: access.connection.authUserId,
      externalShopId: access.connection.externalShopId,
    });
    return jsonResponse({ success: true, stats }, requestId, 202);
  }

  async function handleCreateVerificationSession(request: Request, requestId: string) {
    const body = await jsonFromRequest<{
      authUserId: string;
      providerKey: string;
      verificationMethod?: string;
      redirectUri?: string;
      successRedirectUri?: string;
      discordUserId?: string;
      nonce?: string;
      productId?: string;
      installationHint?: string;
    }>(request);
    const state = randomBytes(16).toString('hex');
    const result = await convex.mutation(api.verificationSessions.createVerificationSession, {
      apiSecret: config.convexApiSecret,
      authUserId: body.authUserId,
      mode: body.providerKey,
      providerKey: body.providerKey,
      verificationMethod: body.verificationMethod ?? 'license_key',
      state,
      redirectUri:
        body.redirectUri ??
        `${config.apiBaseUrl.replace(/\/$/, '')}/verify-success?provider=${encodeURIComponent(body.providerKey)}`,
      successRedirectUri: body.successRedirectUri,
      discordUserId: body.discordUserId,
      nonce: body.nonce,
      productId: body.productId,
      installationHint: body.installationHint,
    });
    return jsonResponse(
      { success: true, sessionId: result.sessionId, expiresAt: result.expiresAt, state },
      requestId,
      201
    );
  }

  async function handleCompleteVerificationSession(
    request: Request,
    requestId: string,
    sessionId: string
  ) {
    const body = await jsonFromRequest<{
      authUserId: string;
      providerKey: string;
      licenseKey?: string;
      connectionId?: string;
      subjectId?: string;
      discordUserId?: string;
    }>(request);
    const access = await requireTenantAccess(auth, convex, config, request, body.authUserId);
    if (!access.ok) return access.response;
    if (body.providerKey !== 'lemonsqueezy')
      return jsonResponse(
        { error: 'Phase 1 completion is only implemented for lemonsqueezy license verification' },
        requestId,
        422
      );
    if (!String(body.licenseKey ?? '').trim())
      return jsonResponse({ error: 'licenseKey is required' }, requestId, 400);

    const connections = await convex.query(api.providerConnections.listConnections, {
      apiSecret: config.convexApiSecret,
      authUserId: body.authUserId,
    });
    const connection = connections.connections.find(
      (entry: { id: string; providerKey?: string; provider?: string }) =>
        entry.id === body.connectionId ||
        entry.providerKey === 'lemonsqueezy' ||
        entry.provider === 'lemonsqueezy'
    );
    if (!connection)
      return jsonResponse({ error: 'Lemon Squeezy connection not found' }, requestId, 404);

    const client = await buildLemonClientForConnection(convex, config, body.authUserId);
    const validation = await client.validateLicenseKey(String(body.licenseKey).trim());
    if (!validation.valid || !validation.license_key)
      return jsonResponse(
        { error: validation.error ?? 'License is invalid or could not be validated' },
        requestId,
        422
      );
    const license = {
      id: String(validation.license_key.id ?? validation.meta?.order_item_id ?? body.licenseKey),
      customerId: validation.meta?.customer_id ? String(validation.meta.customer_id) : undefined,
      orderId: validation.meta?.order_id ? String(validation.meta.order_id) : undefined,
      productId: validation.meta?.product_id,
      variantId: validation.meta?.variant_id,
      userName: validation.meta?.user_name ?? undefined,
      userEmail: validation.meta?.user_email ?? undefined,
    };

    const ensuredSubject = body.subjectId
      ? { subjectId: body.subjectId }
      : body.discordUserId
        ? await convex.mutation(api.subjects.ensureSubjectForDiscord, {
            apiSecret: config.convexApiSecret,
            discordUserId: body.discordUserId,
          })
        : null;
    if (!ensuredSubject?.subjectId)
      return jsonResponse(
        { error: 'subjectId or discordUserId is required to complete verification' },
        requestId,
        400
      );

    const [mappings, catalogProducts] = await Promise.all([
      convex.query(api.providerPlatform.listCatalogMappingsForConnection, {
        apiSecret: config.convexApiSecret,
        providerConnectionId: connection.id,
      }),
      convex.query(api.providerPlatform.listCatalogProductsForTenant, {
        apiSecret: config.convexApiSecret,
        authUserId: body.authUserId,
      }),
    ]);
    const match = resolveCatalogMatch(mappings, catalogProducts, [
      license.variantId ? String(license.variantId) : undefined,
      license.productId ? String(license.productId) : undefined,
    ]);
    if (!match.productId)
      return jsonResponse(
        { error: 'No mapped catalog product found for this Lemon Squeezy license' },
        requestId,
        409
      );

    const normalizedEmail = license.userEmail ? normalizeEmail(license.userEmail) : undefined;
    const verification = await convex.mutation(
      api.licenseVerification.completeLicenseVerification,
      {
        apiSecret: config.convexApiSecret,
        authUserId: body.authUserId,
        subjectId: ensuredSubject.subjectId,
        provider: 'lemonsqueezy',
        providerUserId: String(
          license.customerId ?? license.userEmail ?? license.orderId ?? license.id
        ),
        providerUsername: license.userName ?? undefined,
        providerMetadata: normalizedEmail
          ? { email: normalizedEmail, rawData: validation }
          : { rawData: validation },
        productsToGrant: [
          {
            productId: match.productId,
            catalogProductId: match.catalogProductId,
            sourceReference: `lemonsqueezy:license:${license.id}`,
          },
        ],
      }
    );

    await convex.mutation(api.providerPlatform.upsertEntitlementEvidence, {
      apiSecret: config.convexApiSecret,
      authUserId: body.authUserId,
      subjectId: ensuredSubject.subjectId,
      providerKey: 'lemonsqueezy',
      providerConnectionId: connection.id,
      sourceReference: `lemonsqueezy:license:${license.id}`,
      evidenceType: 'license.validated',
      status: 'active',
      productId: match.productId,
      catalogProductId: match.catalogProductId,
      observedAt: Date.now(),
      metadata: validation,
    });
    const sessionResult = await convex.mutation(
      api.verificationSessions.completeVerificationSession,
      {
        apiSecret: config.convexApiSecret,
        sessionId,
        subjectId: ensuredSubject.subjectId,
      }
    );
    return jsonResponse(
      { success: true, verification, redirectUri: sessionResult.redirectUri },
      requestId
    );
  }

  async function handleProviderWebhook(
    request: Request,
    requestId: string,
    providerKey: string,
    connectionId: string
  ) {
    if (providerKey !== 'lemonsqueezy')
      return jsonResponse(
        { error: 'Canonical webhooks are only implemented for lemonsqueezy in phase 1' },
        requestId,
        404
      );
    const connection = await convex.query(api.providerPlatform.getProviderConnectionAdmin, {
      apiSecret: config.convexApiSecret,
      providerConnectionId: connectionId,
    });
    if (!connection) return jsonResponse({ error: 'Connection not found' }, requestId, 404);

    const secrets = await convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: config.convexApiSecret,
      authUserId: connection.authUserId,
      provider: 'lemonsqueezy',
    });
    const encryptedWebhookSecret =
      connection.remoteWebhookSecretRef ?? secrets?.webhookSecretEncrypted ?? null;
    if (!encryptedWebhookSecret)
      return jsonResponse({ error: 'Webhook secret not configured' }, requestId, 409);

    const rawBody = await request.text();
    const webhookSecret = await decrypt(encryptedWebhookSecret, config.encryptionSecret);
    const signature = request.headers.get('x-signature')?.trim() ?? '';
    const expected = await hmacSha256(webhookSecret, rawBody);
    if (!signature || !timingSafeEqual(expected, signature)) {
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

    const payload = JSON.parse(rawBody) as Record<string, unknown>;
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
    });
    await convex.mutation(api.providerPlatform.updateProviderConnectionState, {
      apiSecret: config.convexApiSecret,
      providerConnectionId: connection.connectionId,
      lastWebhookAt: Date.now(),
      lastHealthcheckAt: Date.now(),
      status: 'active',
    });
    return jsonResponse({ success: true, duplicate: result.duplicate }, requestId, 202);
  }

  return {
    async handleRequest(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const requestId = newRequestId();
      const cacheKey = getIdempotencyCacheKey(request, url.pathname);
      const cached = cacheKey ? getCachedIdempotentResponse(cacheKey, requestId) : null;
      if (cached) return cached;

      let response: Response | null = null;
      try {
        const createConnectionMatch = url.pathname.match(
          /^\/v1\/tenants\/([^/]+)\/provider-connections$/
        );
        if (request.method === 'POST' && createConnectionMatch)
          response = await handleCreateProviderConnection(
            request,
            requestId,
            decodeURIComponent(createConnectionMatch[1] ?? '')
          );
        const credentialsMatch = url.pathname.match(
          /^\/v1\/provider-connections\/([^/]+)\/credentials$/
        );
        if (!response && request.method === 'POST' && credentialsMatch)
          response = await handlePutProviderCredentials(
            request,
            requestId,
            decodeURIComponent(credentialsMatch[1] ?? '')
          );
        const syncMatch = url.pathname.match(
          /^\/v1\/provider-connections\/([^/]+)\/catalog-sync-jobs$/
        );
        if (!response && request.method === 'POST' && syncMatch)
          response = await handleCatalogSyncJob(
            request,
            requestId,
            decodeURIComponent(syncMatch[1] ?? '')
          );
        const reconciliationMatch = url.pathname.match(
          /^\/v1\/provider-connections\/([^/]+)\/reconciliation-jobs$/
        );
        if (!response && request.method === 'POST' && reconciliationMatch)
          response = await handleReconciliationJob(
            request,
            requestId,
            decodeURIComponent(reconciliationMatch[1] ?? '')
          );
        if (!response && request.method === 'POST' && url.pathname === '/v1/verification-sessions')
          response = await handleCreateVerificationSession(request, requestId);
        const completeVerificationMatch = url.pathname.match(
          /^\/v1\/verification-sessions\/([^/]+)\/complete$/
        );
        if (!response && request.method === 'POST' && completeVerificationMatch)
          response = await handleCompleteVerificationSession(
            request,
            requestId,
            decodeURIComponent(completeVerificationMatch[1] ?? '')
          );
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
        response = jsonResponse(
          { error: error instanceof Error ? error.message : 'Internal server error' },
          requestId,
          500
        );
      }

      if (!response) return null;
      const body = await response.clone().text();
      storeIdempotentResponse(cacheKey, response, body);
      return new Response(body, { status: response.status, headers: response.headers });
    },
  };
}
