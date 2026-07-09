import { describe, expect, test } from 'bun:test';
import { detectLicenseFormat } from '@yucp/providers';
import { JINXXY_PURPOSES } from '@yucp/providers/jinxxy/module';
import { api } from '../../../../convex/_generated/api';
import type { Doc, Id } from '../../../../convex/_generated/dataModel';
import { API_SECRET } from '../../../../ops/convex-real/config';
import { PUBLIC_API_SCOPES } from '../../../../packages/shared/src/publicApiScopes';
import { createAuthUserActorBinding } from '../../src/lib/apiActor';
import { encrypt } from '../../src/lib/encrypt';
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

async function seedJinxxyApiKey(authUserId: string, apiKey: string): Promise<void> {
  await getRealApiHarness().convex.mutation(api.providerConnections.upsertProviderConnection, {
    apiSecret: API_SECRET,
    authUserId,
    providerKey: 'jinxxy',
    authMode: 'api_key',
    label: 'E2E Jinxxy connection',
    credentials: [
      {
        credentialKey: 'api_key',
        kind: 'api_key',
        encryptedValue: await encrypt(apiKey, E2E_ENCRYPTION_SECRET, JINXXY_PURPOSES.credential),
      },
    ],
  });
}

async function seedBuyerProviderLink(input: {
  provider: 'jinxxy';
  providerUserId: string;
  subjectId: Id<'subjects'>;
}): Promise<Id<'external_accounts'>> {
  const now = Date.now();
  const externalAccountId = await getRealApiHarness().convex.insert('external_accounts', {
    provider: input.provider,
    providerUserId: input.providerUserId,
    providerUsername: input.providerUserId,
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
  return externalAccountId;
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
  await seedBuyerProviderLink({ provider, providerUserId, subjectId: buyerSubjectId });

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
  creatorAuthUserId: string;
  productId: string;
  provider: 'gumroad' | 'jinxxy';
  subjectId: unknown;
}) {
  const entitlements = await getRealApiHarness().convex.collect('entitlements');
  const matches = entitlements.filter(
    (entitlement) =>
      entitlement.authUserId === input.creatorAuthUserId &&
      entitlement.productId === input.productId &&
      entitlement.sourceProvider === input.provider &&
      entitlement.status === 'active' &&
      entitlement.subjectId === input.subjectId
  );
  expect(matches).toHaveLength(1);
}

async function findActiveProviderEntitlement(input: {
  creatorAuthUserId: string;
  productId: string;
  provider: 'jinxxy';
  subjectId: Id<'subjects'>;
}): Promise<Doc<'entitlements'> | undefined> {
  const entitlements = await getRealApiHarness().convex.collect('entitlements');
  return entitlements.find(
    (entitlement) =>
      entitlement.authUserId === input.creatorAuthUserId &&
      entitlement.productId === input.productId &&
      entitlement.sourceProvider === input.provider &&
      entitlement.status === 'active' &&
      entitlement.subjectId === input.subjectId
  );
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
      await expectActiveProviderEntitlement({
        creatorAuthUserId: journey.creator.authUserId,
        productId: journey.productId,
        provider: 'gumroad',
        subjectId: journey.subjectId,
      });
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
      await expectActiveProviderEntitlement({
        creatorAuthUserId: journey.creator.authUserId,
        productId: journey.productId,
        provider: 'jinxxy',
        subjectId: journey.subjectId,
      });
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
