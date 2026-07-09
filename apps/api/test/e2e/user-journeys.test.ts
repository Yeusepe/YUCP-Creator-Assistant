import { describe, expect, test } from 'bun:test';
import { detectLicenseFormat } from '@yucp/providers';
import { JINXXY_PURPOSES } from '@yucp/providers/jinxxy/module';
import { LEMONSQUEEZY_PURPOSES } from '@yucp/providers/lemonsqueezy/module';
import { PAYHIP_PURPOSES } from '@yucp/providers/payhip/module';
import { PROVIDER_REGISTRY_BY_KEY } from '@yucp/providers/providerMetadata';
import { normalizeEmail, sha256Hex } from '@yucp/shared/crypto';
import { api, internal } from '../../../../convex/_generated/api';
import type { Doc, Id } from '../../../../convex/_generated/dataModel';
import { API_SECRET } from '../../../../ops/convex-real/config';
import { PUBLIC_API_SCOPES } from '../../../../packages/shared/src/publicApiScopes';
import { createAuthUserActorBinding } from '../../src/lib/apiActor';
import { encrypt } from '../../src/lib/encrypt';
import { getProviderRuntime, resolveWebhookPlugin } from '../../src/providers';
import {
  apiJson,
  apiKeyHeaders,
  createBetterAuthUser,
  createPublicApiKey,
  E2E_ENCRYPTION_SECRET,
  getRealApiHarness,
  hashLicenseKey,
  installRealApiHarness,
  seedCreatorProfile,
  seedProductCatalog,
  seedSubject,
  waitForRealBackend,
} from './support/realApiHarness';

installRealApiHarness();

const RAW_LICENSE_KEY = crypto.randomUUID();
const PRODUCT_ID = 'test_e2e_manual_1';
const EXTERNAL_PROVIDER_TEST_TIMEOUT_MS = 60_000;
const ASYNC_JOB_TEST_TIMEOUT_MS = 90_000;
const NONEXISTENT_GUMROAD_LICENSE_KEY = 'ZZZZZZZZ-ZZZZZZZZ-ZZZZZZZZ-ZZZZZZZZ';
const NONEXISTENT_JINXXY_LICENSE_KEY = '00000000-0000-4000-8000-000000000000';
const SUPPORTED_PROVIDER_KEYS = [
  'gumroad',
  'jinxxy',
  'lemonsqueezy',
  'payhip',
  'itchio',
  'patreon',
  'vrchat',
  'manual',
] as const;
const BACKFILL_GRANT_CELLS = [
  { provider: 'gumroad', externalLineItem: false },
  { provider: 'jinxxy', externalLineItem: true },
  { provider: 'lemonsqueezy', externalLineItem: true },
] as const;
const WEBHOOK_GRANT_CELLS = [
  { provider: 'gumroad' },
  { provider: 'jinxxy' },
  { provider: 'lemonsqueezy' },
  { provider: 'payhip' },
] as const;
const RUNTIME_PROVIDER_KEYS = [
  'gumroad',
  'jinxxy',
  'lemonsqueezy',
  'payhip',
  'itchio',
  'patreon',
  'vrchat',
] as const;
const SHARED_WEBHOOK_PROVIDER_KEYS = ['gumroad', 'jinxxy', 'payhip'] as const;
const SEEDED_BACKFILL_PROVIDER_KEYS = ['gumroad', 'jinxxy', 'lemonsqueezy'] as const;

type SupportedProvider = (typeof SUPPORTED_PROVIDER_KEYS)[number];
type BackfillGrantProvider = (typeof BACKFILL_GRANT_CELLS)[number]['provider'];
type WebhookGrantProvider = (typeof WEBHOOK_GRANT_CELLS)[number]['provider'];

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const gumroadEnv = {
  productId: readEnv('E2E_GUMROAD_PRODUCT_ID'),
  licenseKey: readEnv('E2E_GUMROAD_LICENSE_KEY'),
};
const jinxxyEnv = {
  apiKey: readEnv('E2E_JINXXY_API_KEY'),
  licenseKey: readEnv('E2E_JINXXY_LICENSE_KEY'),
  productRef: readEnv('E2E_JINXXY_PRODUCT_REF'),
};
const hasGumroadE2E = Boolean(gumroadEnv.productId && gumroadEnv.licenseKey);
const hasJinxxyE2E = Boolean(jinxxyEnv.apiKey && jinxxyEnv.licenseKey && jinxxyEnv.productRef);
const hasAsyncBackfillE2E = Boolean(jinxxyEnv.apiKey);

if (!hasGumroadE2E) {
  console.log('SKIP gumroad e2e: E2E_GUMROAD_* not set');
}
if (!hasJinxxyE2E) {
  console.log('SKIP jinxxy e2e: E2E_JINXXY_* not set');
}
if (!hasAsyncBackfillE2E) {
  console.log('SKIP jinxxy async backfill e2e: E2E_JINXXY_API_KEY not set');
}

type ProviderLicenseApiResponse = {
  success: boolean;
  provider?: string;
  entitlementIds?: string[];
  error?: string;
};

function uniqueRef(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function requireE2EEnv(name: string): string {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`${name} is required for this real E2E flow`);
  }
  return value;
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
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function uniqueNumericRef(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(100_000_000 + (bytes[0] % 900_000_000));
}

function buildBackfillSourceReference(
  provider: BackfillGrantProvider,
  externalOrderId: string,
  externalLineItemId?: string
): string {
  if (provider === 'gumroad') {
    return `gumroad:${externalOrderId}`;
  }
  return externalLineItemId
    ? `${provider}:${externalOrderId}:${externalLineItemId}`
    : `${provider}:${externalOrderId}`;
}

function buildWebhookSourceReference(
  provider: WebhookGrantProvider,
  externalOrderId: string,
  externalLineItemId?: string
): string {
  if (provider === 'lemonsqueezy') {
    return `lemonsqueezy:order:${externalOrderId}`;
  }
  return buildBackfillSourceReference(
    provider as BackfillGrantProvider,
    externalOrderId,
    externalLineItemId
  );
}

async function normalizeEmailHash(email: string): Promise<string> {
  return await sha256Hex(normalizeEmail(email));
}

async function seedProviderLicenseJourney(input: {
  provider: 'gumroad' | 'jinxxy';
  providerProductRef: string;
  displayName: string;
}) {
  const creator = await createBetterAuthUser({ name: `${input.displayName} Creator` });
  await seedCreatorProfile({
    authUserId: creator.authUserId,
    name: `${input.displayName} Creator`,
  });
  const buyer = await createBetterAuthUser({ name: `${input.displayName} Buyer` });
  const subjectId = await seedSubject(buyer.authUserId);
  await seedProductCatalog({
    authUserId: creator.authUserId,
    productId: input.providerProductRef,
    provider: input.provider,
    providerProductRef: input.providerProductRef,
    displayName: input.displayName,
  });

  return { buyer, creator, productId: input.providerProductRef, subjectId };
}

async function seedProviderConnection(input: {
  authMode: string;
  authUserId: string;
  credentials?: Array<{
    credentialKey: string;
    encryptedValue: string;
    kind:
      | 'api_key'
      | 'api_token'
      | 'oauth_access_token'
      | 'oauth_refresh_token'
      | 'webhook_secret'
      | 'remote_webhook'
      | 'store_selector';
  }>;
  externalShopId?: string;
  externalShopName?: string;
  provider: SupportedProvider;
  webhookConfigured?: boolean;
  webhookEndpoint?: string;
  webhookRouteToken?: string;
  webhookSecretRef?: string;
}): Promise<Id<'provider_connections'>> {
  return await getRealApiHarness().convex.mutation(
    api.providerConnections.upsertProviderConnection,
    {
      apiSecret: API_SECRET,
      authUserId: input.authUserId,
      providerKey: input.provider,
      authMode: input.authMode,
      label: `E2E ${input.provider} connection`,
      credentials: input.credentials ?? [],
      externalShopId: input.externalShopId,
      externalShopName: input.externalShopName,
      webhookConfigured: input.webhookConfigured,
      webhookEndpoint: input.webhookEndpoint,
      webhookRouteToken: input.webhookRouteToken,
      webhookSecretRef: input.webhookSecretRef,
    }
  );
}

async function seedJinxxyApiKey(authUserId: string, apiKey: string): Promise<void> {
  await seedProviderConnection({
    authUserId,
    provider: 'jinxxy',
    authMode: 'api_key',
    credentials: [
      {
        credentialKey: 'api_key',
        kind: 'api_key',
        encryptedValue: await encrypt(apiKey, E2E_ENCRYPTION_SECRET, JINXXY_PURPOSES.credential),
      },
    ],
  });
}

async function seedProviderIdentityLink(input: {
  authUserId: string;
  email?: string;
  provider: SupportedProvider;
  providerUserId: string;
  subjectId: Id<'subjects'>;
}): Promise<{ emailHash?: string; externalAccountId: Id<'external_accounts'> }> {
  const now = Date.now();
  const emailHash = input.email ? await normalizeEmailHash(input.email) : undefined;
  const externalAccountId = await getRealApiHarness().convex.insert('external_accounts', {
    provider: input.provider,
    providerUserId: input.providerUserId,
    providerUsername: input.providerUserId,
    emailHash,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  await getRealApiHarness().convex.insert('buyer_provider_links', {
    subjectId: input.subjectId,
    provider: input.provider,
    externalAccountId,
    status: 'active',
    linkedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await getRealApiHarness().convex.insert('bindings', {
    authUserId: input.authUserId,
    subjectId: input.subjectId,
    externalAccountId,
    bindingType: 'verification',
    status: 'active',
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  return { emailHash, externalAccountId };
}

type AsyncBackfillJourney = {
  buyerSubjectId: Id<'subjects'>;
  creatorAuthUserId: string;
  discordUserId: string;
  externalOrderId: string;
  productId: string;
  provider: 'jinxxy';
  providerProductRef: string;
};

async function seedAsyncBackfillJourney(): Promise<AsyncBackfillJourney> {
  const provider = 'jinxxy';
  const creator = await createBetterAuthUser({ name: 'Async Backfill Creator' });
  await seedCreatorProfile({
    authUserId: creator.authUserId,
    name: 'Async Backfill Creator',
  });
  await seedJinxxyApiKey(creator.authUserId, requireE2EEnv('E2E_JINXXY_API_KEY'));

  const buyer = await createBetterAuthUser({ name: 'Async Backfill Buyer' });
  const discordUserId = uniqueRef('discord_async_buyer');
  const buyerSubjectId = await seedSubject(buyer.authUserId, { discordUserId });
  const providerUserId = uniqueRef('jinxxy_buyer');
  await seedProviderIdentityLink({
    authUserId: creator.authUserId,
    provider,
    providerUserId,
    subjectId: buyerSubjectId,
  });

  const productId = uniqueRef('e2e_async_product');
  const providerProductRef = uniqueRef('e2e_async_provider_product');
  const externalOrderId = uniqueRef('jinxxy_order');
  const now = Date.now();
  await getRealApiHarness().convex.insert('purchase_facts', {
    authUserId: creator.authUserId,
    provider,
    externalOrderId,
    providerUserId,
    providerProductId: providerProductRef,
    paymentStatus: 'completed',
    lifecycleStatus: 'active',
    purchasedAt: now - 7 * 24 * 60 * 60 * 1000,
    createdAt: now,
    updatedAt: now,
  });

  await getRealApiHarness().convex.mutation(api.role_rules.addCatalogProduct, {
    apiSecret: API_SECRET,
    authUserId: creator.authUserId,
    productId,
    providerProductRef,
    provider,
    canonicalUrl: `https://jinxxy.app/products/${providerProductRef}`,
    supportsAutoDiscovery: true,
    displayName: 'Async Backfill E2E Product',
  });

  return {
    buyerSubjectId,
    creatorAuthUserId: creator.authUserId,
    discordUserId,
    externalOrderId,
    productId,
    provider,
    providerProductRef,
  };
}

type ProviderGrantJourney<TProvider extends SupportedProvider = SupportedProvider> = {
  buyerAuthUserId: string;
  buyerEmail: string;
  buyerEmailHash: string;
  catalogProductId: Id<'product_catalog'>;
  creatorAuthUserId: string;
  externalLineItemId?: string;
  externalOrderId: string;
  productId: string;
  provider: TProvider;
  providerProductRef: string;
  providerUserId: string;
  sourceReference: string;
  subjectId: Id<'subjects'>;
};

async function seedGrantJourney<TProvider extends SupportedProvider>(input: {
  displayName: string;
  externalLineItem?: boolean;
  productRef?: string;
  provider: TProvider;
  sourceReferenceFor: (externalOrderId: string, externalLineItemId?: string) => string;
}): Promise<ProviderGrantJourney<TProvider>> {
  const creator = await createBetterAuthUser({ name: `${input.displayName} Creator` });
  await seedCreatorProfile({
    authUserId: creator.authUserId,
    name: `${input.displayName} Creator`,
  });
  const buyer = await createBetterAuthUser({
    email: `${uniqueRef(`${input.provider}_buyer`)}@example.com`,
    name: `${input.displayName} Buyer`,
  });
  const subjectId = await seedSubject(buyer.authUserId);
  const productId = uniqueRef(`e2e_${input.provider}_product`);
  const providerProductRef =
    input.productRef ?? uniqueRef(`e2e_${input.provider}_provider_product`);
  const catalogProductId = await seedProductCatalog({
    authUserId: creator.authUserId,
    productId,
    provider: input.provider,
    providerProductRef,
    displayName: input.displayName,
  });
  const providerUserId = uniqueRef(`${input.provider}_buyer`);
  const { emailHash } = await seedProviderIdentityLink({
    authUserId: creator.authUserId,
    email: buyer.email,
    provider: input.provider,
    providerUserId,
    subjectId,
  });
  if (!emailHash) {
    throw new Error(`Failed to seed ${input.provider} identity email hash`);
  }
  const externalOrderId = uniqueRef(`${input.provider}_order`);
  const externalLineItemId = input.externalLineItem
    ? uniqueRef(`${input.provider}_line`)
    : undefined;
  return {
    buyerAuthUserId: buyer.authUserId,
    buyerEmail: buyer.email,
    buyerEmailHash: emailHash,
    catalogProductId,
    creatorAuthUserId: creator.authUserId,
    externalLineItemId,
    externalOrderId,
    productId,
    provider: input.provider,
    providerProductRef,
    providerUserId,
    sourceReference: input.sourceReferenceFor(externalOrderId, externalLineItemId),
    subjectId,
  };
}

async function seedBackfillGrantJourney(input: {
  externalLineItem: boolean;
  provider: BackfillGrantProvider;
}): Promise<ProviderGrantJourney<BackfillGrantProvider>> {
  const journey = await seedGrantJourney({
    displayName: `${input.provider} Backfill Parity`,
    externalLineItem: input.externalLineItem,
    provider: input.provider,
    sourceReferenceFor: (externalOrderId, externalLineItemId) =>
      buildBackfillSourceReference(input.provider, externalOrderId, externalLineItemId),
  });
  const now = Date.now();

  await getRealApiHarness().convex.insert('purchase_facts', {
    authUserId: journey.creatorAuthUserId,
    provider: journey.provider,
    externalOrderId: journey.externalOrderId,
    externalLineItemId: journey.externalLineItemId,
    buyerEmailHash: journey.buyerEmailHash,
    providerUserId: journey.providerUserId,
    providerProductId: journey.providerProductRef,
    paymentStatus: 'completed',
    lifecycleStatus: 'active',
    purchasedAt: now - 7 * 24 * 60 * 60 * 1000,
    createdAt: now,
    updatedAt: now,
  });

  return journey;
}

type WebhookGrantJourney = ProviderGrantJourney<WebhookGrantProvider> & {
  apiKey?: string;
  connectionId?: Id<'provider_connections'>;
  secret?: string;
  webhookRouteToken?: string;
};

async function seedWebhookGrantJourney(
  provider: WebhookGrantProvider
): Promise<WebhookGrantJourney> {
  const journey = await seedGrantJourney({
    displayName: `${provider} Webhook Parity`,
    externalLineItem: provider !== 'gumroad',
    productRef: provider === 'lemonsqueezy' ? uniqueNumericRef() : undefined,
    provider,
    sourceReferenceFor: (externalOrderId, externalLineItemId) =>
      buildWebhookSourceReference(provider, externalOrderId, externalLineItemId),
  });
  const webhookRouteToken = uniqueRef(`${provider}_route`);
  if (provider === 'gumroad') {
    const connectionId = await seedProviderConnection({
      authUserId: journey.creatorAuthUserId,
      provider,
      authMode: 'oauth',
      webhookConfigured: true,
      webhookEndpoint: `http://127.0.0.1:3001/webhooks/${provider}/${webhookRouteToken}`,
      webhookRouteToken,
    });
    return { ...journey, connectionId, webhookRouteToken };
  }
  if (provider === 'jinxxy') {
    const secret = uniqueRef('jinxxy_webhook_secret');
    const connectionId = await seedProviderConnection({
      authUserId: journey.creatorAuthUserId,
      provider,
      authMode: 'api_key',
      webhookConfigured: true,
      webhookEndpoint: `http://127.0.0.1:3001/webhooks/${provider}/${webhookRouteToken}`,
      webhookRouteToken,
      credentials: [
        {
          credentialKey: 'webhook_secret',
          kind: 'webhook_secret',
          encryptedValue: await encrypt(
            secret,
            E2E_ENCRYPTION_SECRET,
            JINXXY_PURPOSES.webhookSecret
          ),
        },
      ],
    });
    return { ...journey, connectionId, secret, webhookRouteToken };
  }
  if (provider === 'payhip') {
    const apiKey = uniqueRef('payhip_api_key');
    const connectionId = await seedProviderConnection({
      authUserId: journey.creatorAuthUserId,
      provider,
      authMode: 'api_key',
      webhookConfigured: true,
      webhookEndpoint: `http://127.0.0.1:3001/webhooks/${provider}/${webhookRouteToken}`,
      webhookRouteToken,
      credentials: [
        {
          credentialKey: 'api_key',
          kind: 'api_key',
          encryptedValue: await encrypt(apiKey, E2E_ENCRYPTION_SECRET, PAYHIP_PURPOSES.credential),
        },
      ],
    });
    return { ...journey, apiKey, connectionId, webhookRouteToken };
  }

  const secret = uniqueRef('lemonsqueezy_webhook_secret');
  const connectionId = await seedProviderConnection({
    authUserId: journey.creatorAuthUserId,
    provider,
    authMode: 'api_token',
    externalShopId: uniqueNumericRef(),
    externalShopName: 'E2E LemonSqueezy Store',
    webhookConfigured: true,
    webhookEndpoint: 'http://127.0.0.1:3001/v1/webhooks/lemonsqueezy/e2e',
    webhookSecretRef: await encrypt(
      secret,
      E2E_ENCRYPTION_SECRET,
      LEMONSQUEEZY_PURPOSES.webhookSecret
    ),
  });
  return { ...journey, connectionId, secret };
}

async function postWebhookGrant(journey: WebhookGrantJourney): Promise<Response> {
  if (journey.provider === 'gumroad') {
    if (!journey.webhookRouteToken) {
      throw new Error('Gumroad webhook route token was not seeded');
    }
    const body = new URLSearchParams({
      sale_id: journey.externalOrderId,
      product_id: journey.providerProductRef,
      email: journey.buyerEmail,
      sale_timestamp: String(Math.floor(Date.now() / 1000)),
    });
    return await getRealApiHarness().app.fetch(`/webhooks/gumroad/${journey.webhookRouteToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  }

  if (journey.provider === 'jinxxy') {
    if (!journey.secret || !journey.webhookRouteToken || !journey.externalLineItemId) {
      throw new Error('Jinxxy webhook seed data is incomplete');
    }
    const rawBody = JSON.stringify({
      event_id: `${journey.externalOrderId}:order.created`,
      event_type: 'order.created',
      created_at: new Date().toISOString(),
      data: {
        id: journey.externalOrderId,
        email: journey.buyerEmail,
        payment_status: 'PAID',
        created_at: new Date().toISOString(),
        user: { id: journey.providerUserId },
        order_items: [
          {
            id: journey.externalLineItemId,
            target_type: 'DIGITAL_PRODUCT',
            target_id: journey.providerProductRef,
            target_version_id: uniqueRef('jinxxy_version'),
          },
        ],
      },
    });
    return await getRealApiHarness().app.fetch(`/webhooks/jinxxy/${journey.webhookRouteToken}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': `sha256=${await hmacSha256(journey.secret, rawBody)}`,
      },
      body: rawBody,
    });
  }

  if (journey.provider === 'payhip') {
    if (!journey.apiKey || !journey.webhookRouteToken || !journey.externalLineItemId) {
      throw new Error('Payhip webhook seed data is incomplete');
    }
    const rawBody = JSON.stringify({
      id: journey.externalOrderId,
      email: journey.buyerEmail,
      type: 'paid',
      signature: await sha256Hex(journey.apiKey),
      date: Math.floor(Date.now() / 1000),
      items: [
        {
          product_id: journey.externalLineItemId,
          product_key: journey.providerProductRef,
          product_name: 'Payhip Webhook Parity Product',
          product_permalink: `https://payhip.com/b/${journey.providerProductRef}`,
        },
      ],
    });
    return await getRealApiHarness().app.fetch(`/webhooks/payhip/${journey.webhookRouteToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
    });
  }

  if (!journey.secret || !journey.connectionId || !journey.externalLineItemId) {
    throw new Error('LemonSqueezy webhook seed data is incomplete');
  }
  const rawBody = JSON.stringify({
    meta: { event_name: 'order_created' },
    data: {
      id: journey.externalOrderId,
      type: 'orders',
      attributes: {
        user_email: journey.buyerEmail,
        order_number: Number(uniqueNumericRef()),
        store_id: Number(uniqueNumericRef()),
        customer_id: Number(uniqueNumericRef()),
        currency: 'USD',
        subtotal: 1000,
        total: 1000,
        created_at: new Date().toISOString(),
        first_order_item: {
          id: journey.externalLineItemId,
          product_id: Number(journey.providerProductRef),
          variant_id: Number(journey.providerProductRef),
        },
      },
    },
  });
  return await getRealApiHarness().app.fetch(`/v1/webhooks/lemonsqueezy/${journey.connectionId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature': await hmacSha256(journey.secret, rawBody),
    },
    body: rawBody,
  });
}

async function processPendingWebhookEvents(): Promise<{
  errors: string[];
  failed: number;
  processed: number;
}> {
  return await getRealApiHarness().convex.action<{
    errors: string[];
    failed: number;
    processed: number;
  }>(internal.webhookProcessing.processPendingWebhookEvents, {
    apiSecret: API_SECRET,
    limit: 10,
  });
}

async function completeProviderLicense(input: {
  licenseKey: string;
  provider: 'gumroad' | 'jinxxy';
  productId: string;
  creatorAuthUserId: string;
  buyerAuthUserId: string;
  buyerSubjectId: string;
}): Promise<{ body: ProviderLicenseApiResponse; response: Response }> {
  return await apiJson<ProviderLicenseApiResponse>('/api/verification/complete-license', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      apiSecret: API_SECRET,
      licenseKey: input.licenseKey,
      provider: input.provider,
      productId: input.productId,
      creatorAuthUserId: input.creatorAuthUserId,
      buyerAuthUserId: input.buyerAuthUserId,
      buyerSubjectId: input.buyerSubjectId,
    }),
  });
}

async function completeProviderLicenseWithRetry(
  input: Parameters<typeof completeProviderLicense>[0]
): Promise<{ body: ProviderLicenseApiResponse; response: Response }> {
  const first = await completeProviderLicense(input);
  if (first.body.success) {
    return first;
  }
  return await completeProviderLicense(input);
}

async function fetchExternalWithOneRetry(
  label: string,
  request: () => Promise<Response>
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await request();
      if (response.status < 500) {
        return response;
      }
      lastError = new Error(`${label} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(
    `${label} unreachable after retry: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

async function assertGumroadLicenseEndpointReachable(input: {
  licenseKey: string;
  productId: string;
}): Promise<void> {
  const body = new URLSearchParams({
    product_id: input.productId,
    license_key: input.licenseKey,
    increment_uses_count: 'false',
  });
  // Gumroad licenses API reference: https://gumroad.com/api#licenses
  const response = await fetchExternalWithOneRetry('Gumroad license verification API', () =>
    fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    })
  );
  const payload = (await response.json().catch(() => null)) as { success?: unknown } | null;
  if (!payload || typeof payload.success !== 'boolean') {
    throw new Error('Gumroad license verification API returned an unexpected response shape');
  }
}

async function assertJinxxyLicenseEndpointReachable(input: {
  apiKey: string;
  licenseKey: string;
}): Promise<void> {
  const url = new URL('https://api.creators.jinxxy.com/v1/licenses');
  url.searchParams.set('key', input.licenseKey);
  // Jinxxy Creator API reference: https://api.creators.jinxxy.com/v1/docs
  const response = await fetchExternalWithOneRetry('Jinxxy license lookup API', () =>
    fetch(url, {
      headers: {
        Accept: 'application/json',
        'x-api-key': input.apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    })
  );
  if (response.status === 401 || response.status === 403) {
    return;
  }
  const payload = (await response.json().catch(() => null)) as { results?: unknown } | null;
  if (!payload || !Array.isArray(payload.results)) {
    throw new Error('Jinxxy license lookup API returned an unexpected response shape');
  }
}

async function expectActiveProviderEntitlement(input: {
  catalogProductId?: Id<'product_catalog'>;
  creatorAuthUserId: string;
  entitlementId?: string;
  productId: string;
  provider: SupportedProvider;
  sourceReference?: string;
  subjectId: unknown;
}): Promise<Doc<'entitlements'>> {
  const entitlements = await getRealApiHarness().convex.collect('entitlements');
  const matches = entitlements.filter(
    (entitlement) =>
      entitlement.authUserId === input.creatorAuthUserId &&
      entitlement.productId === input.productId &&
      entitlement.sourceProvider === input.provider &&
      entitlement.status === 'active' &&
      entitlement.subjectId === input.subjectId &&
      (input.sourceReference === undefined ||
        entitlement.sourceReference === input.sourceReference) &&
      (input.entitlementId === undefined || String(entitlement._id) === input.entitlementId)
  );
  expect(matches).toHaveLength(1);
  const [entitlement] = matches;
  if (!entitlement) {
    throw new Error(`Expected active ${input.provider} entitlement`);
  }
  if (input.catalogProductId !== undefined) {
    expect(entitlement.catalogProductId).toBe(input.catalogProductId);
  }
  if (input.sourceReference !== undefined) {
    expect(entitlement.sourceReference).toBe(input.sourceReference);
  }
  return entitlement;
}

async function findActiveProviderEntitlement(input: {
  creatorAuthUserId: string;
  productId: string;
  provider: SupportedProvider;
  sourceReference?: string;
  subjectId: Id<'subjects'>;
}): Promise<Doc<'entitlements'> | undefined> {
  const entitlements = await getRealApiHarness().convex.collect('entitlements');
  return entitlements.find(
    (entitlement) =>
      entitlement.authUserId === input.creatorAuthUserId &&
      entitlement.productId === input.productId &&
      entitlement.sourceProvider === input.provider &&
      entitlement.status === 'active' &&
      entitlement.subjectId === input.subjectId &&
      (input.sourceReference === undefined || entitlement.sourceReference === input.sourceReference)
  );
}

async function waitForActiveProviderEntitlement(input: {
  catalogProductId?: Id<'product_catalog'>;
  creatorAuthUserId: string;
  productId: string;
  provider: SupportedProvider;
  sourceReference: string;
  subjectId: Id<'subjects'>;
}): Promise<Doc<'entitlements'>> {
  let entitlement: Doc<'entitlements'> | undefined;
  await waitForRealBackend(
    async () => {
      entitlement = await findActiveProviderEntitlement(input);
      return Boolean(entitlement);
    },
    {
      description: `${input.provider} grant to project an active entitlement`,
      intervalMs: 250,
      timeoutMs: 15_000,
    }
  );
  return await expectActiveProviderEntitlement(input);
}

async function waitForAsyncBackfillEntitlement(
  journey: AsyncBackfillJourney
): Promise<Doc<'entitlements'>> {
  let entitlement: Doc<'entitlements'> | undefined;
  await waitForRealBackend(
    async () => {
      entitlement = await findActiveProviderEntitlement({
        creatorAuthUserId: journey.creatorAuthUserId,
        productId: journey.productId,
        provider: journey.provider,
        subjectId: journey.buyerSubjectId,
      });
      return Boolean(entitlement);
    },
    {
      description: 'scheduled backfill to project a seeded purchase into an entitlement',
      intervalMs: 1_000,
      timeoutMs: 45_000,
    }
  );
  if (!entitlement) {
    throw new Error('Scheduled backfill completed without an entitlement match');
  }
  return entitlement;
}

function readOutboxPayload(job: Doc<'outbox_jobs'>): Record<string, unknown> {
  return job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload)
    ? (job.payload as Record<string, unknown>)
    : {};
}

async function findRoleSyncOutboxJob(input: {
  creatorAuthUserId: string;
  entitlementId: Id<'entitlements'>;
  subjectId: Id<'subjects'>;
}): Promise<Doc<'outbox_jobs'> | undefined> {
  const jobs = await getRealApiHarness().convex.collect('outbox_jobs');
  return jobs.find((job) => {
    const payload = readOutboxPayload(job);
    return (
      job.authUserId === input.creatorAuthUserId &&
      job.jobType === 'role_sync' &&
      payload.entitlementId === input.entitlementId &&
      payload.subjectId === input.subjectId
    );
  });
}

async function expectNoEntitlements(): Promise<void> {
  expect(await getRealApiHarness().convex.collect('entitlements')).toHaveLength(0);
}

describe('real API user journeys against self-hosted Convex', () => {
  // [F20] Blocked on createApiKey ArgumentValidationError: apikey.userId required by convex/betterAuth/schema.ts:83, not supplied by @better-auth/api-key@1.6.13.
  test('[F20] smoke reads a seeded API key through the real API router', async () => {
    const creator = await createBetterAuthUser({ name: 'Smoke Creator' });
    const apiKey = await createPublicApiKey(creator.authUserId, PUBLIC_API_SCOPES);

    const { body, response } = await apiJson<{
      authUserId: string;
      expiresAt: number | null;
      keyId: string | null;
      object: string;
      scopes: string[];
    }>('/api/public/v2/me', {
      headers: apiKeyHeaders(apiKey),
    });

    expect(response.status).toBe(200);
    expect(body).toEqual({
      object: 'api_key_info',
      authUserId: creator.authUserId,
      scopes: PUBLIC_API_SCOPES,
      keyId: expect.any(String),
      expiresAt: null,
    });
  });

  // [F20] Blocked on createApiKey ArgumentValidationError: apikey.userId required by convex/betterAuth/schema.ts:83, not supplied by @better-auth/api-key@1.6.13.
  test('[F20] manual-license issue and validate round-trips through raw key HMAC storage', async () => {
    const creator = await createBetterAuthUser({ name: 'Manual License Creator' });
    const apiKey = await createPublicApiKey(creator.authUserId, PUBLIC_API_SCOPES);

    const issued = await apiJson<{ licenseId: string }>('/api/public/v2/manual-licenses', {
      method: 'POST',
      headers: apiKeyHeaders(apiKey),
      body: JSON.stringify({ key: RAW_LICENSE_KEY, product_id: PRODUCT_ID }),
    });

    expect(issued.response.status).toBe(201);
    expect(issued.body.licenseId).toStartWith('j');

    const licenses = await getRealApiHarness().convex.collect('manual_licenses');
    expect(licenses).toHaveLength(1);
    const [license] = licenses;
    expect(String(license._id)).toBe(issued.body.licenseId);
    expect(license.authUserId).toBe(creator.authUserId);
    expect(license.productId).toBe(PRODUCT_ID);
    expect(license.status).toBe('active');
    expect(license.licenseKeyHash).toBe(await hashLicenseKey(RAW_LICENSE_KEY));
    expect(JSON.stringify(license)).not.toContain(RAW_LICENSE_KEY);

    const valid = await apiJson<{
      licenseId?: string;
      reason?: string;
      valid: boolean;
    }>('/api/public/v2/manual-licenses/validate', {
      method: 'POST',
      headers: apiKeyHeaders(apiKey),
      body: JSON.stringify({ key: RAW_LICENSE_KEY, product_id: PRODUCT_ID }),
    });

    expect(valid.response.status).toBe(200);
    expect(valid.body).toMatchObject({
      valid: true,
      licenseId: issued.body.licenseId,
    });

    const invalid = await apiJson<{ reason?: string; valid: boolean }>(
      '/api/public/v2/manual-licenses/validate',
      {
        method: 'POST',
        headers: apiKeyHeaders(apiKey),
        body: JSON.stringify({ key: crypto.randomUUID(), product_id: PRODUCT_ID }),
      }
    );

    expect(invalid.response.status).toBe(200);
    expect(invalid.body).toEqual({ valid: false, reason: 'not_found' });
  });

  test('manual-license reachable layer stores only HMAC and validates by hash', async () => {
    const creator = await createBetterAuthUser({ name: 'Manual License Convex Creator' });
    const actor = await createAuthUserActorBinding({
      authUserId: creator.authUserId,
      source: 'api_key',
      scopes: PUBLIC_API_SCOPES,
    });
    const licenseKeyHash = await hashLicenseKey(RAW_LICENSE_KEY);

    const created = await getRealApiHarness().convex.mutation<{ licenseId: string }>(
      api.manualLicenses.create,
      {
        apiSecret: API_SECRET,
        actor,
        authUserId: creator.authUserId,
        licenseKeyHash,
        productId: PRODUCT_ID,
      }
    );

    const licenses = await getRealApiHarness().convex.collect('manual_licenses');
    expect(licenses).toHaveLength(1);
    const [license] = licenses;
    expect(String(license._id)).toBe(created.licenseId);
    expect(license.licenseKeyHash).toBe(licenseKeyHash);
    expect(JSON.stringify(license)).not.toContain(RAW_LICENSE_KEY);

    const valid = await getRealApiHarness().convex.query<{
      licenseId?: string;
      valid: boolean;
    }>(api.manualLicenses.validateByHash, {
      apiSecret: API_SECRET,
      actor,
      authUserId: creator.authUserId,
      licenseKeyHash,
      productId: PRODUCT_ID,
    });
    expect(valid).toMatchObject({ valid: true, licenseId: created.licenseId });
  });

  test('provider parity registry guard keeps supported providers reachable', () => {
    for (const provider of SUPPORTED_PROVIDER_KEYS) {
      const descriptor = PROVIDER_REGISTRY_BY_KEY[provider];
      expect(descriptor?.providerKey).toBe(provider);
      expect(descriptor?.status).toBe('active');
    }

    for (const provider of RUNTIME_PROVIDER_KEYS) {
      expect(getProviderRuntime(provider)?.id).toBe(provider);
    }

    const manual = PROVIDER_REGISTRY_BY_KEY.manual;
    expect(manual.creatorAuthModes).toContain('none');
    expect(manual.buyerVerificationMethods).toContain('manual');
    expect(api.manualLicenses.create).toBeDefined();

    for (const provider of SHARED_WEBHOOK_PROVIDER_KEYS) {
      const resolved = resolveWebhookPlugin(provider);
      expect(resolved?.providerId).toBe(provider);
      expect(resolved?.webhook).toBeDefined();
    }

    const lemon = PROVIDER_REGISTRY_BY_KEY.lemonsqueezy;
    expect(lemon.supportsWebhook).toBe(true);
    expect(lemon.capabilities).toContain('managed_webhooks');

    for (const provider of SEEDED_BACKFILL_PROVIDER_KEYS) {
      const runtime = getProviderRuntime(provider) as { backfill?: unknown } | undefined;
      expect(runtime?.backfill).toBeDefined();
    }
  });

  for (const cell of BACKFILL_GRANT_CELLS) {
    test(
      `provider parity backfill grant projects ${cell.provider} entitlement`,
      async () => {
        const journey = await seedBackfillGrantJourney(cell);
        const projection = await getRealApiHarness().convex.mutation(
          internal.backgroundSync.projectBackfilledPurchasesForProduct,
          {
            authUserId: journey.creatorAuthUserId,
            productId: journey.productId,
            provider: journey.provider,
            providerProductRef: journey.providerProductRef,
          }
        );

        expect(projection).toMatchObject({
          purchaseFactsFound: 1,
          linkedToSubject: 1,
          entitlementsGranted: 1,
          skippedInactive: 0,
          unresolved: 0,
        });

        await waitForActiveProviderEntitlement({
          catalogProductId: journey.catalogProductId,
          creatorAuthUserId: journey.creatorAuthUserId,
          productId: journey.productId,
          provider: journey.provider,
          sourceReference: journey.sourceReference,
          subjectId: journey.subjectId,
        });

        const facts = await getRealApiHarness().convex.collect('purchase_facts');
        expect(facts).toContainEqual(
          expect.objectContaining({
            authUserId: journey.creatorAuthUserId,
            externalOrderId: journey.externalOrderId,
            provider: journey.provider,
            providerProductId: journey.providerProductRef,
            subjectId: journey.subjectId,
          })
        );
      },
      ASYNC_JOB_TEST_TIMEOUT_MS
    );
  }

  for (const cell of WEBHOOK_GRANT_CELLS) {
    test(
      `provider parity webhook grant projects ${cell.provider} entitlement`,
      async () => {
        const journey = await seedWebhookGrantJourney(cell.provider);
        const response = await postWebhookGrant(journey);
        expect([200, 202]).toContain(response.status);
        const processing = await processPendingWebhookEvents();
        expect(processing).toMatchObject({ failed: 0, processed: 1 });

        await waitForActiveProviderEntitlement({
          catalogProductId: journey.catalogProductId,
          creatorAuthUserId: journey.creatorAuthUserId,
          productId: journey.productId,
          provider: journey.provider,
          sourceReference: journey.sourceReference,
          subjectId: journey.subjectId,
        });

        const events = await getRealApiHarness().convex.collect('webhook_events');
        expect(events).toContainEqual(
          expect.objectContaining({
            authUserId: journey.creatorAuthUserId,
            provider: journey.provider,
            status: 'processed',
          })
        );
      },
      ASYNC_JOB_TEST_TIMEOUT_MS
    );
  }

  test('provider parity no-silent-failure guard includes provider signal', async () => {
    const creator = await createBetterAuthUser({ name: 'Webhook Failure Signal Creator' });
    await seedCreatorProfile({
      authUserId: creator.authUserId,
      name: 'Webhook Failure Signal Creator',
    });
    const webhookRouteToken = uniqueRef('jinxxy_failure_route');
    const secret = uniqueRef('jinxxy_failure_secret');
    await seedProviderConnection({
      authUserId: creator.authUserId,
      provider: 'jinxxy',
      authMode: 'api_key',
      webhookConfigured: true,
      webhookEndpoint: `http://127.0.0.1:3001/webhooks/jinxxy/${webhookRouteToken}`,
      webhookRouteToken,
      credentials: [
        {
          credentialKey: 'webhook_secret',
          kind: 'webhook_secret',
          encryptedValue: await encrypt(
            secret,
            E2E_ENCRYPTION_SECRET,
            JINXXY_PURPOSES.webhookSecret
          ),
        },
      ],
    });
    const rawBody = JSON.stringify({
      event_id: uniqueRef('jinxxy_failure_event'),
      event_type: 'order.created',
      created_at: new Date().toISOString(),
    });
    const response = await getRealApiHarness().app.fetch(`/webhooks/jinxxy/${webhookRouteToken}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': `sha256=${await hmacSha256(secret, rawBody)}`,
      },
      body: rawBody,
    });
    expect(response.status).toBe(200);

    const processing = await processPendingWebhookEvents();
    expect(processing).toMatchObject({
      failed: 1,
      processed: 0,
      errors: [expect.stringContaining('Jinxxy')],
    });
    const events = await getRealApiHarness().convex.collect('webhook_events');
    expect(events).toContainEqual(
      expect.objectContaining({
        provider: 'jinxxy',
        status: 'failed',
        errorMessage: expect.stringContaining('Jinxxy'),
      })
    );
    await expectNoEntitlements();
  });

  test.skipIf(!hasGumroadE2E)(
    'gumroad real license redeem mints an active entitlement',
    async () => {
      const productId = gumroadEnv.productId;
      const licenseKey = gumroadEnv.licenseKey;
      if (!productId || !licenseKey) {
        throw new Error('Gumroad E2E env was not available after skip gate');
      }

      const journey = await seedProviderLicenseJourney({
        provider: 'gumroad',
        providerProductRef: productId,
        displayName: 'Gumroad License E2E',
      });

      const result = await completeProviderLicenseWithRetry({
        licenseKey,
        provider: 'gumroad',
        productId: journey.productId,
        creatorAuthUserId: journey.creator.authUserId,
        buyerAuthUserId: journey.buyer.authUserId,
        buyerSubjectId: String(journey.subjectId),
      });

      expect(result.response.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(result.body.provider).toBe('gumroad');
      expect(result.body.entitlementIds?.length ?? 0).toBeGreaterThan(0);
      const entitlement = await expectActiveProviderEntitlement({
        creatorAuthUserId: journey.creator.authUserId,
        entitlementId: result.body.entitlementIds?.[0],
        productId: journey.productId,
        provider: 'gumroad',
        subjectId: journey.subjectId,
      });
      expect(entitlement.sourceReference).toStartWith('gumroad:');
    },
    EXTERNAL_PROVIDER_TEST_TIMEOUT_MS
  );

  test(
    'gumroad non-existent license fails closed without minting entitlement',
    async () => {
      expect(detectLicenseFormat(NONEXISTENT_GUMROAD_LICENSE_KEY)).toBe('gumroad');
      const journey = await seedProviderLicenseJourney({
        provider: 'gumroad',
        providerProductRef: 'test_e2e_gumroad_missing_product',
        displayName: 'Gumroad Missing License E2E',
      });
      await assertGumroadLicenseEndpointReachable({
        licenseKey: NONEXISTENT_GUMROAD_LICENSE_KEY,
        productId: journey.productId,
      });

      const result = await completeProviderLicense({
        licenseKey: NONEXISTENT_GUMROAD_LICENSE_KEY,
        provider: 'gumroad',
        productId: journey.productId,
        creatorAuthUserId: journey.creator.authUserId,
        buyerAuthUserId: journey.buyer.authUserId,
        buyerSubjectId: String(journey.subjectId),
      });

      expect(result.response.status).toBe(400);
      expect(result.body.success).toBe(false);
      expect(typeof result.body.error).toBe('string');
      await expectNoEntitlements();
    },
    EXTERNAL_PROVIDER_TEST_TIMEOUT_MS
  );

  test.skipIf(!hasJinxxyE2E)(
    'jinxxy real license redeem mints an active entitlement',
    async () => {
      const apiKey = jinxxyEnv.apiKey;
      const licenseKey = jinxxyEnv.licenseKey;
      const productRef = jinxxyEnv.productRef;
      if (!apiKey || !licenseKey || !productRef) {
        throw new Error('Jinxxy E2E env was not available after skip gate');
      }

      const journey = await seedProviderLicenseJourney({
        provider: 'jinxxy',
        providerProductRef: productRef,
        displayName: 'Jinxxy License E2E',
      });
      await seedJinxxyApiKey(journey.creator.authUserId, apiKey);

      const result = await completeProviderLicenseWithRetry({
        licenseKey,
        provider: 'jinxxy',
        productId: journey.productId,
        creatorAuthUserId: journey.creator.authUserId,
        buyerAuthUserId: journey.buyer.authUserId,
        buyerSubjectId: String(journey.subjectId),
      });

      expect(result.response.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(result.body.provider).toBe('jinxxy');
      expect(result.body.entitlementIds?.length ?? 0).toBeGreaterThan(0);
      const entitlement = await expectActiveProviderEntitlement({
        creatorAuthUserId: journey.creator.authUserId,
        entitlementId: result.body.entitlementIds?.[0],
        productId: journey.productId,
        provider: 'jinxxy',
        subjectId: journey.subjectId,
      });
      expect(entitlement.sourceReference).toStartWith('jinxxy:');
    },
    EXTERNAL_PROVIDER_TEST_TIMEOUT_MS
  );

  test.skipIf(!hasAsyncBackfillE2E)(
    'scheduled catalog backfill materializes a linked historical purchase entitlement',
    async () => {
      const journey = await seedAsyncBackfillJourney();
      const entitlement = await waitForAsyncBackfillEntitlement(journey);

      expect(entitlement).toMatchObject({
        authUserId: journey.creatorAuthUserId,
        productId: journey.productId,
        sourceProvider: journey.provider,
        status: 'active',
        subjectId: journey.buyerSubjectId,
      });
      expect(entitlement.sourceReference).toBe(`${journey.provider}:${journey.externalOrderId}`);
    },
    ASYNC_JOB_TEST_TIMEOUT_MS
  );

  test.skipIf(!hasAsyncBackfillE2E)(
    'scheduled catalog backfill entitlement grant enqueues a role sync outbox job',
    async () => {
      const journey = await seedAsyncBackfillJourney();
      const entitlement = await waitForAsyncBackfillEntitlement(journey);
      let roleSyncJob: Doc<'outbox_jobs'> | undefined;

      await waitForRealBackend(
        async () => {
          roleSyncJob = await findRoleSyncOutboxJob({
            creatorAuthUserId: journey.creatorAuthUserId,
            entitlementId: entitlement._id,
            subjectId: journey.buyerSubjectId,
          });
          return Boolean(roleSyncJob);
        },
        {
          description: 'role_sync outbox job for the granted entitlement',
          intervalMs: 1_000,
          timeoutMs: 15_000,
        }
      );

      if (!roleSyncJob) {
        throw new Error('Entitlement grant completed without a role_sync outbox job');
      }
      const payload = readOutboxPayload(roleSyncJob);
      expect(roleSyncJob.authUserId).toBe(journey.creatorAuthUserId);
      expect(roleSyncJob.jobType).toBe('role_sync');
      expect(roleSyncJob.targetDiscordUserId).toBe(journey.discordUserId);
      expect(payload.entitlementId).toBe(entitlement._id);
      expect(payload.subjectId).toBe(journey.buyerSubjectId);
    },
    ASYNC_JOB_TEST_TIMEOUT_MS
  );

  test(
    'jinxxy non-existent license fails closed without minting entitlement',
    async () => {
      expect(detectLicenseFormat(NONEXISTENT_JINXXY_LICENSE_KEY)).toBe('jinxxy');
      const journey = await seedProviderLicenseJourney({
        provider: 'jinxxy',
        providerProductRef: jinxxyEnv.productRef ?? 'test_e2e_jinxxy_missing_product',
        displayName: 'Jinxxy Missing License E2E',
      });
      const apiKey = jinxxyEnv.apiKey ?? 'invalid-e2e-jinxxy-api-key';
      await assertJinxxyLicenseEndpointReachable({
        apiKey,
        licenseKey: NONEXISTENT_JINXXY_LICENSE_KEY,
      });
      await seedJinxxyApiKey(journey.creator.authUserId, apiKey);

      const result = await completeProviderLicense({
        licenseKey: NONEXISTENT_JINXXY_LICENSE_KEY,
        provider: 'jinxxy',
        productId: journey.productId,
        creatorAuthUserId: journey.creator.authUserId,
        buyerAuthUserId: journey.buyer.authUserId,
        buyerSubjectId: String(journey.subjectId),
      });

      expect(result.response.status).toBe(400);
      expect(result.body.success).toBe(false);
      expect(typeof result.body.error).toBe('string');
      await expectNoEntitlements();
    },
    EXTERNAL_PROVIDER_TEST_TIMEOUT_MS
  );

  // [F21] verifyIntentWithManualLicense -> internal.yucpLicenses.verifyLicenseProof returns invalid_proof, no entitlement minted.
  test('[F21] public-v2 manual license redeem should mint an active entitlement', async () => {
    const creator = await createBetterAuthUser({ name: 'Manual Redeem Creator' });
    const buyer = await createBetterAuthUser({ name: 'Manual Redeem Buyer' });
    const subjectId = await seedSubject(buyer.authUserId);

    await getRealApiHarness().convex.mutation(api.manualLicenses.create, {
      apiSecret: API_SECRET,
      actor: await createAuthUserActorBinding({
        authUserId: creator.authUserId,
        source: 'api_key',
        scopes: PUBLIC_API_SCOPES,
      }),
      authUserId: creator.authUserId,
      licenseKeyHash: await hashLicenseKey(RAW_LICENSE_KEY),
      productId: PRODUCT_ID,
    });
    await seedProductCatalog({
      authUserId: creator.authUserId,
      productId: PRODUCT_ID,
      provider: 'manual',
      providerProductRef: PRODUCT_ID,
    });

    const intent = await getRealApiHarness().convex.mutation<{ intentId: string }>(
      api.verificationIntents.createVerificationIntent,
      {
        apiSecret: API_SECRET,
        authUserId: buyer.authUserId,
        packageId: 'com.yucp.e2e.manual',
        packageName: 'Manual License E2E',
        machineFingerprint: 'machine-e2e-manual',
        codeChallenge: 'challenge-e2e-manual',
        returnUrl: 'http://127.0.0.1:3000/verify/return',
        requirements: [
          {
            methodKey: 'manual-license',
            providerKey: 'manual',
            kind: 'manual_license',
            title: 'Manual license',
            creatorAuthUserId: creator.authUserId,
            productId: PRODUCT_ID,
            providerProductRef: PRODUCT_ID,
          },
        ],
      }
    );

    const result = await getRealApiHarness().convex.action<{ success: boolean }>(
      api.verificationIntents.verifyIntentWithManualLicense,
      {
        apiSecret: API_SECRET,
        authUserId: buyer.authUserId,
        intentId: intent.intentId,
        methodKey: 'manual-license',
        licenseKey: RAW_LICENSE_KEY,
      }
    );

    const entitlements = await getRealApiHarness().convex.collect('entitlements');
    expect(result.success).toBe(true);
    expect(entitlements).toContainEqual(
      expect.objectContaining({
        authUserId: creator.authUserId,
        productId: PRODUCT_ID,
        sourceProvider: 'manual',
        status: 'active',
        subjectId,
      })
    );
  });

  // [F20] Blocked on createApiKey ArgumentValidationError: apikey.userId required by convex/betterAuth/schema.ts:83, not supplied by @better-auth/api-key@1.6.13.
  test('[F20] webhook create returns a sanitized secret and persists only encrypted storage', async () => {
    const creator = await createBetterAuthUser({ name: 'Webhook Creator' });
    const apiKey = await createPublicApiKey(creator.authUserId, PUBLIC_API_SCOPES);

    const created = await apiJson<{
      _id: string;
      enabled: boolean;
      events: string[];
      signingSecret: string;
      signingSecretEnc?: string;
      status: string;
      url: string;
    }>('/api/public/v2/webhooks', {
      method: 'POST',
      headers: apiKeyHeaders(apiKey),
      body: JSON.stringify({
        url: 'https://example.com/hook',
        events: ['ping'],
        enabled: true,
      }),
    });

    expect(created.response.status).toBe(201);
    expect(created.body._id).toStartWith('j');
    expect(created.body.url).toBe('https://example.com/hook');
    expect(created.body.events).toEqual(['ping']);
    expect(created.body.enabled).toBe(true);
    expect(created.body.status).toBe('active');
    expect(created.body.signingSecret).toStartWith('whsec_');
    expect(created.body.signingSecretEnc).toBeUndefined();

    const subscriptions = await getRealApiHarness().convex.collect('webhook_subscriptions');
    expect(subscriptions).toHaveLength(1);
    const [subscription] = subscriptions;
    expect(String(subscription._id)).toBe(created.body._id);
    expect(subscription.authUserId).toBe(creator.authUserId);
    expect(subscription.signingSecretEnc).toBeString();
    expect(subscription.signingSecretEnc).not.toBe(created.body.signingSecret);
    expect(JSON.stringify(subscription)).not.toContain(created.body.signingSecret);
  });
});
