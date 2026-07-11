import { PROVIDER_REGISTRY } from '@yucp/providers/providerMetadata';
import { sha256Hex } from '@yucp/shared/crypto';
import { setPinnedYucpRootsForTests } from '@yucp/shared/yucpTrust';
import { symmetricEncrypt } from 'better-auth/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { getPublicKeyFromPrivate } from './lib/yucpCrypto';
import {
  makeTestConvex,
  seedCreatorProfile,
  seedEntitlement,
  seedGuildLink,
  seedRoleRule,
  seedSubject,
} from './testHelpers';

const API_SECRET = 'test-secret';
const originalEncryptionSecret = process.env.ENCRYPTION_SECRET;

async function seedExternalAccount(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    provider?: string;
    providerUserId?: string;
    providerUsername?: string;
    emailHash?: string;
    status?: 'active' | 'disconnected' | 'revoked';
  } = {}
): Promise<Id<'external_accounts'>> {
  return t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert('external_accounts', {
      provider: overrides.provider ?? 'vrchat',
      providerUserId: overrides.providerUserId ?? `provider-user-${now}`,
      providerUsername: overrides.providerUsername,
      emailHash: overrides.emailHash,
      status: overrides.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedPurchaseFact(
  t: ReturnType<typeof makeTestConvex>,
  args: {
    authUserId: string;
    provider: 'gumroad' | 'itchio' | 'jinxxy' | 'vrchat' | 'payhip' | 'lemonsqueezy';
    providerProductId: string;
    externalOrderId: string;
    buyerEmailHash?: string;
    providerUserId?: string;
  }
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert('purchase_facts', {
      authUserId: args.authUserId,
      provider: args.provider,
      externalOrderId: args.externalOrderId,
      buyerEmailHash: args.buyerEmailHash,
      providerUserId: args.providerUserId,
      providerProductId: args.providerProductId,
      paymentStatus: 'paid',
      lifecycleStatus: 'active',
      purchasedAt: now - 60_000,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedVerificationBinding(
  t: ReturnType<typeof makeTestConvex>,
  args: {
    authUserId: string;
    subjectId: Id<'subjects'>;
    externalAccountId: Id<'external_accounts'>;
    status?: 'pending' | 'active' | 'revoked' | 'transferred' | 'quarantined';
  }
): Promise<Id<'bindings'>> {
  return t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert('bindings', {
      authUserId: args.authUserId,
      subjectId: args.subjectId,
      externalAccountId: args.externalAccountId,
      bindingType: 'verification',
      status: args.status ?? 'active',
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedCatalogProduct(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    authUserId?: string;
    productId?: string;
    provider?: 'gumroad' | 'itchio' | 'jinxxy' | 'vrchat' | 'payhip' | 'lemonsqueezy' | 'manual';
    providerProductRef?: string;
    displayName?: string;
  } = {}
): Promise<Id<'product_catalog'>> {
  return t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert('product_catalog', {
      authUserId: overrides.authUserId ?? 'auth-catalog-owner',
      productId: overrides.productId ?? 'product-catalog-1',
      provider: overrides.provider ?? 'gumroad',
      providerProductRef: overrides.providerProductRef ?? 'gumroad-product-1',
      displayName: overrides.displayName ?? 'Catalog Product',
      status: 'active',
      supportsAutoDiscovery: true,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return Buffer.from(new Uint8Array(digest))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function hashManualLicenseKey(key: string): Promise<string> {
  const encryptionSecret = process.env.ENCRYPTION_SECRET;
  if (!encryptionSecret) {
    throw new Error('ENCRYPTION_SECRET is required for manual-license realtests');
  }
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(encryptionSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(key));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('JWT must contain exactly three parts');
  }

  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')) as Record<string, unknown>;
}

async function configurePinnedTestRoot(): Promise<void> {
  const rootPrivateKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const rootPublicKey = await getPublicKeyFromPrivate(rootPrivateKey);
  process.env.YUCP_ROOT_KEY_ID = 'yucp-root';
  process.env.YUCP_ROOT_PRIVATE_KEY = rootPrivateKey;
  process.env.YUCP_ROOT_PUBLIC_KEY = rootPublicKey;
  setPinnedYucpRootsForTests([
    {
      keyId: 'yucp-root',
      algorithm: 'Ed25519',
      publicKeyBase64: rootPublicKey,
    },
  ]);
}

afterEach(() => {
  setPinnedYucpRootsForTests(null);
  if (originalEncryptionSecret === undefined) {
    delete process.env.ENCRYPTION_SECRET;
  } else {
    process.env.ENCRYPTION_SECRET = originalEncryptionSecret;
  }
});

describe('verification intents buyer provider links', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    process.env.CONVEX_API_SECRET = API_SECRET;
    process.env.CONVEX_SITE_URL = 'https://rare-squid-409.convex.site';
    process.env.BETTER_AUTH_SECRET = 'test-better-auth-secret';
    globalThis.fetch = originalFetch;
    await configurePinnedTestRoot();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('verifies a buyer_provider_link requirement when the buyer has an active link', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-buyer-link-success';
    const subjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-buyer-link-success',
    });
    const externalAccountId = await seedExternalAccount(t, {
      provider: 'vrchat',
      providerUserId: 'vrchat-user-123',
      providerUsername: 'BuyerVR',
    });

    await t.mutation(api.subjects.upsertBuyerProviderLink, {
      apiSecret: API_SECRET,
      subjectId,
      provider: 'vrchat',
      externalAccountId,
      verificationMethod: 'account_link',
    });

    const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId,
      packageId: 'pkg-buyer-link',
      machineFingerprint: 'machine-success',
      codeChallenge: 'challenge-success',
      returnUrl: 'https://example.com/return',
      requirements: [
        {
          methodKey: 'vrchat-link',
          providerKey: 'vrchat',
          kind: 'buyer_provider_link',
          title: 'Linked VRChat account',
        },
      ],
    });

    const result = await t.action(api.verificationIntents.verifyIntentWithBuyerProviderLink, {
      apiSecret: API_SECRET,
      authUserId,
      intentId,
      methodKey: 'vrchat-link',
    });

    expect(result).toEqual({ success: true });

    const intent = await t.query(api.verificationIntents.getIntentRecord, {
      apiSecret: API_SECRET,
      authUserId,
      intentId,
    });

    expect(intent?.status).toBe('verified');
    expect(intent?.verifiedMethodKey).toBe('vrchat-link');
  });

  it('canonicalizes legacy itch manual-license intents into buyer-provider-link requirements', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-itch-legacy-link';
    const subjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-itch-legacy-link',
    });
    const externalAccountId = await seedExternalAccount(t, {
      provider: 'itchio',
      providerUserId: 'itch-user-legacy',
      providerUsername: 'LegacyItchBuyer',
    });

    await t.mutation(api.subjects.upsertBuyerProviderLink, {
      apiSecret: API_SECRET,
      subjectId,
      provider: 'itchio',
      externalAccountId,
      verificationMethod: 'account_link',
    });

    const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId,
      packageId: 'pkg-itch-legacy',
      machineFingerprint: 'machine-itch-legacy',
      codeChallenge: 'challenge-itch-legacy',
      returnUrl: 'https://example.com/return',
      requirements: [
        {
          methodKey: 'itchio-link',
          providerKey: 'itchio',
          kind: 'manual_license',
          title: 'itch.io download key',
          providerProductRef: '42',
        },
      ],
    });

    const storedIntent = await t.query(api.verificationIntents.getIntentRecord, {
      apiSecret: API_SECRET,
      authUserId,
      intentId,
    });

    expect(storedIntent?.requirements).toMatchObject([
      {
        methodKey: 'itchio-link',
        providerKey: 'itchio',
        kind: 'buyer_provider_link',
        providerProductRef: '42',
      },
    ]);
  });

  it('resolves missing buyer-provider-link product context through the public Convex lookups', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-gumroad-legacy-creator';
    const buyerAuthUserId = 'auth-gumroad-legacy-buyer';
    const packageId = 'pkg-gumroad-legacy-link';
    const productId = 'product-gumroad-legacy-link';
    const providerProductRef = 'QAJc7ErxdAC815P5P8R89g==';
    const buyerEmailHash = await sha256Hex('buyer@example.com');
    const subjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-gumroad-legacy-link',
    });
    await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-gumroad-legacy-creator',
    });
    const externalAccountId = await seedExternalAccount(t, {
      provider: 'gumroad',
      providerUserId: 'gumroad-user-legacy',
      providerUsername: 'LegacyGumroadBuyer',
      emailHash: buyerEmailHash,
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId,
      packageName: 'Legacy Gumroad Linked Package',
      publisherId: 'publisher-gumroad-legacy-link',
      yucpUserId: creatorAuthUserId,
    });

    await seedCatalogProduct(t, {
      authUserId: creatorAuthUserId,
      productId,
      provider: 'gumroad',
      providerProductRef,
      displayName: 'Legacy Gumroad Linked Product',
    });

    await seedPurchaseFact(t, {
      authUserId: creatorAuthUserId,
      provider: 'gumroad',
      providerProductId: providerProductRef,
      externalOrderId: 'gumroad-order-legacy',
      buyerEmailHash,
    });

    await t.mutation(api.subjects.upsertBuyerProviderLink, {
      apiSecret: API_SECRET,
      subjectId,
      provider: 'gumroad',
      externalAccountId,
      verificationMethod: 'account_link',
    });

    const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      packageId,
      machineFingerprint: 'machine-gumroad-legacy-link',
      codeChallenge: 'challenge-gumroad-legacy-link',
      returnUrl: 'https://example.com/return',
      requirements: [
        {
          methodKey: 'gumroad-link',
          providerKey: 'gumroad',
          kind: 'buyer_provider_link',
          title: 'Linked Gumroad account',
          providerProductRef,
        },
      ],
    });

    const result = await t.action(api.verificationIntents.verifyIntentWithBuyerProviderLink, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      intentId,
      methodKey: 'gumroad-link',
    });

    expect(result).toEqual({ success: true });
    await expect(
      t.query(internal.yucpLicenses.checkSubjectEntitlement, {
        authUserId: creatorAuthUserId,
        subjectId,
        productId,
      })
    ).resolves.toBe(true);
  });

  it('verifies manual-license intents through the public Convex action when Gumroad accepts product_permalink fallback', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-manual-license-creator';
    const buyerAuthUserId = 'auth-manual-license-buyer';
    const packageId = 'pkg.manual-license';
    const productId = 'product-manual-license';
    const providerProductRef = 'gumroad-product-manual-license';
    const encryptedAccessToken = await symmetricEncrypt({
      key: process.env.BETTER_AUTH_SECRET as string,
      data: 'gumroad-access-token',
    });
    let requestCount = 0;

    globalThis.fetch = async (input, init) => {
      requestCount += 1;
      expect(String(input)).toBe('https://api.gumroad.com/v2/licenses/verify');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(String(init?.body)).toContain('access_token=gumroad-access-token');
      expect(String(init?.body)).toContain('license_key=license_123');
      if (requestCount === 1) {
        expect(String(init?.body)).toContain(`product_id=${providerProductRef}`);
        return new Response(
          JSON.stringify({
            success: false,
            message: 'That license does not exist for the provided product.',
          }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      expect(String(init?.body)).toContain(`product_permalink=${providerProductRef}`);
      return new Response(
        JSON.stringify({
          success: true,
          purchase: {
            product_permalink: providerProductRef,
            email: 'buyer@example.com',
            sale_id: 'sale_123',
            refunded: false,
            chargebacked: false,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId,
      packageName: 'Manual License Package',
      publisherId: 'publisher-manual-license',
      yucpUserId: creatorAuthUserId,
    });

    await seedCatalogProduct(t, {
      authUserId: creatorAuthUserId,
      productId,
      provider: 'gumroad',
      providerProductRef,
      displayName: 'Manual License Product',
    });

    const connectionId = await t.mutation(api.providerConnections.createProviderConnection, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      providerKey: 'gumroad',
      authMode: 'oauth',
      label: 'Gumroad Store',
    });

    await t.mutation(api.providerConnections.putProviderCredential, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      providerConnectionId: connectionId,
      credentialKey: 'oauth_access_token',
      kind: 'oauth_access_token',
      encryptedValue: encryptedAccessToken,
    });

    const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      packageId,
      machineFingerprint: 'machine-manual-license',
      codeChallenge: 'challenge-manual-license',
      returnUrl: 'https://example.com/return',
      requirements: [
        {
          methodKey: 'gumroad-license',
          providerKey: 'gumroad',
          kind: 'manual_license',
          title: 'Gumroad license',
          providerProductRef,
        },
      ],
    });

    const result = await t.action(api.verificationIntents.verifyIntentWithManualLicense, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      intentId,
      methodKey: 'gumroad-license',
      licenseKey: 'license_123',
    });

    expect(result).toEqual({ success: true });
    expect(requestCount).toBe(2);

    const intent = await t.query(api.verificationIntents.getIntentRecord, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      intentId,
    });

    expect(intent?.status).toBe('verified');
    expect(intent?.verifiedMethodKey).toBe('gumroad-license');
  });

  it('allows an existing owner to retry an expired YUCP manual license without consuming another use', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-yucp-manual-license-creator';
    const buyerAuthUserId = 'auth-yucp-manual-license-buyer';
    const packageId = 'pkg.yucp-manual-license';
    const productId = 'product-yucp-manual-license';
    const licenseKey = 'test-yucp-manual-license-key';
    if (!originalEncryptionSecret) {
      throw new Error('ENCRYPTION_SECRET is required for manual-license realtests');
    }
    process.env.ENCRYPTION_SECRET = `${originalEncryptionSecret}\n`;
    const subjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-yucp-manual-license-buyer',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId,
      packageName: 'YUCP Manual License Package',
      publisherId: 'publisher-yucp-manual-license',
      yucpUserId: creatorAuthUserId,
    });
    await seedCatalogProduct(t, {
      authUserId: 'auth-yucp-manual-license-other-creator',
      productId,
      provider: 'manual',
      providerProductRef: productId,
      displayName: 'Different creator manual product',
    });
    await seedCatalogProduct(t, {
      authUserId: creatorAuthUserId,
      productId,
      provider: 'manual',
      providerProductRef: productId,
      displayName: 'YUCP Manual License Product',
    });
    await t.mutation(api.manualLicenses.create, {
      apiSecret: API_SECRET,
      authUserId: 'auth-yucp-manual-license-other-creator',
      licenseKeyHash: await hashManualLicenseKey(licenseKey),
      productId,
      maxUses: 1,
    });
    const { licenseId } = await t.mutation(api.manualLicenses.create, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      licenseKeyHash: await hashManualLicenseKey(licenseKey),
      productId,
      maxUses: 1,
    });
    const sourceReference = `manual:${await sha256Hex(String(licenseId))}`;

    const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      packageId,
      machineFingerprint: 'machine-yucp-manual-license',
      codeChallenge: 'challenge-yucp-manual-license',
      returnUrl: 'https://example.com/return',
      requirements: [
        {
          methodKey: 'manual-license',
          providerKey: 'manual',
          kind: 'manual_license',
          title: 'YUCP manual license',
          providerProductRef: productId,
          creatorAuthUserId,
          productId,
        },
      ],
    });

    const result = await t.action(api.verificationIntents.verifyIntentWithManualLicense, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      intentId,
      methodKey: 'manual-license',
      licenseKey,
    });

    expect(result).toEqual({ success: true });
    const entitlements = await t.run((ctx) =>
      ctx.db
        .query('entitlements')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', creatorAuthUserId).eq('subjectId', subjectId)
        )
        .collect()
    );
    expect(entitlements).toEqual([
      expect.objectContaining({
        productId,
        sourceProvider: 'manual',
        sourceReference,
        status: 'active',
      }),
    ]);
    const evidence = await t.run((ctx) =>
      ctx.db
        .query('entitlement_evidence')
        .withIndex('by_source_reference', (q) =>
          q.eq('providerKey', 'manual').eq('sourceReference', sourceReference)
        )
        .filter((q) => q.eq(q.field('authUserId'), creatorAuthUserId))
        .first()
    );
    expect(evidence).toMatchObject({
      subjectId,
      providerKey: 'manual',
      sourceReference,
      evidenceType: 'manual_license_redeemed',
      status: 'active',
      productId,
    });
    const consumedLicense = await t.run((ctx) => ctx.db.get(licenseId));
    expect(consumedLicense).toMatchObject({
      currentUses: 1,
      status: 'exhausted',
    });
    const expiredAt = Date.now() - 1;
    await t.run(async (ctx) => {
      await ctx.db.patch(licenseId, {
        status: 'expired',
        expiresAt: expiredAt,
        updatedAt: Date.now(),
      });
    });

    const { intentId: sameBuyerRetryIntentId } = await t.mutation(
      api.verificationIntents.createVerificationIntent,
      {
        apiSecret: API_SECRET,
        authUserId: buyerAuthUserId,
        packageId,
        machineFingerprint: 'machine-yucp-manual-license-same-buyer-retry',
        codeChallenge: 'challenge-yucp-manual-license-same-buyer-retry',
        returnUrl: 'https://example.com/return',
        requirements: [
          {
            methodKey: 'manual-license',
            providerKey: 'manual',
            kind: 'manual_license',
            title: 'YUCP manual license',
            providerProductRef: productId,
            creatorAuthUserId,
            productId,
          },
        ],
      }
    );
    expect(
      await t.action(api.verificationIntents.verifyIntentWithManualLicense, {
        apiSecret: API_SECRET,
        authUserId: buyerAuthUserId,
        intentId: sameBuyerRetryIntentId,
        methodKey: 'manual-license',
        licenseKey,
      })
    ).toEqual({ success: true });
    expect(await t.run((ctx) => ctx.db.get(licenseId))).toMatchObject({
      currentUses: 1,
      status: 'expired',
      expiresAt: expiredAt,
    });

    const retryBuyerAuthUserId = 'auth-yucp-manual-license-retry-buyer';
    const retrySubjectId = await seedSubject(t, {
      authUserId: retryBuyerAuthUserId,
      primaryDiscordUserId: 'discord-yucp-manual-license-retry-buyer',
    });
    const { intentId: retryIntentId } = await t.mutation(
      api.verificationIntents.createVerificationIntent,
      {
        apiSecret: API_SECRET,
        authUserId: retryBuyerAuthUserId,
        packageId,
        machineFingerprint: 'machine-yucp-manual-license-retry',
        codeChallenge: 'challenge-yucp-manual-license-retry',
        returnUrl: 'https://example.com/return',
        requirements: [
          {
            methodKey: 'manual-license',
            providerKey: 'manual',
            kind: 'manual_license',
            title: 'YUCP manual license',
            providerProductRef: productId,
            creatorAuthUserId,
            productId,
          },
        ],
      }
    );
    const retryResult = await t.action(api.verificationIntents.verifyIntentWithManualLicense, {
      apiSecret: API_SECRET,
      authUserId: retryBuyerAuthUserId,
      intentId: retryIntentId,
      methodKey: 'manual-license',
      licenseKey,
    });
    expect(retryResult).toEqual({
      success: false,
      errorCode: 'invalid_proof',
      errorMessage: 'License verification failed',
    });
    const retryEntitlements = await t.run((ctx) =>
      ctx.db
        .query('entitlements')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', creatorAuthUserId).eq('subjectId', retrySubjectId)
        )
        .collect()
    );
    expect(retryEntitlements).toEqual([]);
  });

  it('does not consume another manual-license use when its entitlement is already active', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-yucp-manual-license-redeem-creator';
    const buyerAuthUserId = 'auth-yucp-manual-license-redeem-buyer';
    const packageId = 'pkg.yucp-manual-license-redeem';
    const productId = 'product-yucp-manual-license-redeem';
    const licenseKey = 'test-yucp-manual-license-redeem-key';
    const subjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-yucp-manual-license-redeem-buyer',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId,
      packageName: 'YUCP Manual License Redeem Package',
      publisherId: 'publisher-yucp-manual-license-redeem',
      yucpUserId: creatorAuthUserId,
    });
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: creatorAuthUserId,
      productId,
      provider: 'manual',
      providerProductRef: productId,
      displayName: 'YUCP Manual License Redeem Product',
    });
    const { licenseId } = await t.mutation(api.manualLicenses.create, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      licenseKeyHash: await hashManualLicenseKey(licenseKey),
      productId,
      maxUses: 2,
    });

    const createIntent = async (authUserId: string, machineFingerprint: string) =>
      await t.mutation(api.verificationIntents.createVerificationIntent, {
        apiSecret: API_SECRET,
        authUserId,
        packageId,
        machineFingerprint,
        codeChallenge: `challenge-${machineFingerprint}`,
        returnUrl: 'https://example.com/return',
        requirements: [
          {
            methodKey: 'manual-license',
            providerKey: 'manual',
            kind: 'manual_license',
            title: 'YUCP manual license',
            providerProductRef: productId,
            creatorAuthUserId,
            productId,
          },
        ],
      });

    const { intentId: firstIntentId } = await createIntent(
      buyerAuthUserId,
      'machine-yucp-manual-license-redeem-first'
    );
    expect(
      await t.action(api.verificationIntents.verifyIntentWithManualLicense, {
        apiSecret: API_SECRET,
        authUserId: buyerAuthUserId,
        intentId: firstIntentId,
        methodKey: 'manual-license',
        licenseKey,
      })
    ).toEqual({ success: true });

    const { intentId: repeatIntentId } = await createIntent(
      buyerAuthUserId,
      'machine-yucp-manual-license-redeem-repeat'
    );
    expect(
      await t.action(api.verificationIntents.verifyIntentWithManualLicense, {
        apiSecret: API_SECRET,
        authUserId: buyerAuthUserId,
        intentId: repeatIntentId,
        methodKey: 'manual-license',
        licenseKey,
      })
    ).toEqual({ success: true });

    expect(await t.run((ctx) => ctx.db.get(licenseId))).toMatchObject({
      currentUses: 1,
      status: 'active',
    });
    const buyerEntitlements = await t.run((ctx) =>
      ctx.db
        .query('entitlements')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', creatorAuthUserId).eq('subjectId', subjectId)
        )
        .collect()
    );
    expect(buyerEntitlements).toHaveLength(1);
    expect(buyerEntitlements[0]).toMatchObject({ catalogProductId });

    const secondBuyerAuthUserId = 'auth-yucp-manual-license-redeem-second-buyer';
    const secondSubjectId = await seedSubject(t, {
      authUserId: secondBuyerAuthUserId,
      primaryDiscordUserId: 'discord-yucp-manual-license-redeem-second-buyer',
    });
    const { intentId: secondBuyerIntentId } = await createIntent(
      secondBuyerAuthUserId,
      'machine-yucp-manual-license-redeem-second-buyer'
    );
    expect(
      await t.action(api.verificationIntents.verifyIntentWithManualLicense, {
        apiSecret: API_SECRET,
        authUserId: secondBuyerAuthUserId,
        intentId: secondBuyerIntentId,
        methodKey: 'manual-license',
        licenseKey,
      })
    ).toEqual({ success: true });
    expect(await t.run((ctx) => ctx.db.get(licenseId))).toMatchObject({
      currentUses: 2,
      status: 'exhausted',
    });
    const secondBuyerEntitlements = await t.run((ctx) =>
      ctx.db
        .query('entitlements')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', creatorAuthUserId).eq('subjectId', secondSubjectId)
        )
        .collect()
    );
    expect(secondBuyerEntitlements).toHaveLength(1);
  });

  it('rejects an oversized valid manual license key before entitlement grant', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-yucp-manual-license-oversized-creator';
    const buyerAuthUserId = 'auth-yucp-manual-license-oversized-buyer';
    const packageId = 'pkg.yucp-manual-license-oversized';
    const productId = 'product-yucp-manual-license-oversized';
    const licenseKey = 'x'.repeat(4097);
    const subjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-yucp-manual-license-oversized-buyer',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId,
      packageName: 'YUCP Manual License Oversized Package',
      publisherId: 'publisher-yucp-manual-license-oversized',
      yucpUserId: creatorAuthUserId,
    });
    await seedCatalogProduct(t, {
      authUserId: creatorAuthUserId,
      productId,
      provider: 'manual',
      providerProductRef: productId,
      displayName: 'YUCP Manual License Oversized Product',
    });
    await t.mutation(api.manualLicenses.create, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      licenseKeyHash: await hashManualLicenseKey(licenseKey),
      productId,
    });
    const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      packageId,
      machineFingerprint: 'machine-yucp-manual-license-oversized',
      codeChallenge: 'challenge-yucp-manual-license-oversized',
      returnUrl: 'https://example.com/return',
      requirements: [
        {
          methodKey: 'manual-license',
          providerKey: 'manual',
          kind: 'manual_license',
          title: 'YUCP manual license',
          providerProductRef: productId,
          creatorAuthUserId,
          productId,
        },
      ],
    });

    expect(
      await t.action(api.verificationIntents.verifyIntentWithManualLicense, {
        apiSecret: API_SECRET,
        authUserId: buyerAuthUserId,
        intentId,
        methodKey: 'manual-license',
        licenseKey,
      })
    ).toEqual({
      success: false,
      errorCode: 'invalid_proof',
      errorMessage: 'License verification failed',
    });
    const entitlements = await t.run((ctx) =>
      ctx.db
        .query('entitlements')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', creatorAuthUserId).eq('subjectId', subjectId)
        )
        .collect()
    );
    expect(entitlements).toEqual([]);
  });

  it('verifies manual-license intents through the public Convex action when Gumroad accepts product_id directly', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-manual-license-product-id-creator';
    const buyerAuthUserId = 'auth-manual-license-product-id-buyer';
    const packageId = 'pkg.manual-license.product-id';
    const productId = 'product-manual-license-product-id';
    const providerProductRef = 'QAJc7ErxdAC815P5P8R89g==';
    const encryptedAccessToken = await symmetricEncrypt({
      key: process.env.BETTER_AUTH_SECRET as string,
      data: 'gumroad-access-token',
    });
    let requestCount = 0;

    globalThis.fetch = async (input, init) => {
      requestCount += 1;
      expect(String(input)).toBe('https://api.gumroad.com/v2/licenses/verify');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(String(init?.body)).toContain('access_token=gumroad-access-token');
      expect(String(init?.body)).toContain(
        `product_id=${encodeURIComponent(providerProductRef)}`
      );
      expect(String(init?.body)).toContain('license_key=license_123');
      expect(String(init?.body)).not.toContain('product_permalink=');
      return new Response(
        JSON.stringify({
          success: true,
          purchase: {
            product_permalink: 'song-thing',
            email: 'buyer@example.com',
            sale_id: 'sale_456',
            refunded: false,
            chargebacked: false,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId,
      packageName: 'Manual License Product ID Package',
      publisherId: 'publisher-manual-license-product-id',
      yucpUserId: creatorAuthUserId,
    });

    await seedCatalogProduct(t, {
      authUserId: creatorAuthUserId,
      productId,
      provider: 'gumroad',
      providerProductRef,
      displayName: 'Manual License Product ID Product',
    });

    const connectionId = await t.mutation(api.providerConnections.createProviderConnection, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      providerKey: 'gumroad',
      authMode: 'oauth',
      label: 'Gumroad Store',
    });

    await t.mutation(api.providerConnections.putProviderCredential, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      providerConnectionId: connectionId,
      credentialKey: 'oauth_access_token',
      kind: 'oauth_access_token',
      encryptedValue: encryptedAccessToken,
    });

    const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      packageId,
      machineFingerprint: 'machine-manual-license-product-id',
      codeChallenge: 'challenge-manual-license-product-id',
      returnUrl: 'https://example.com/return',
      requirements: [
        {
          methodKey: 'gumroad-license',
          providerKey: 'gumroad',
          kind: 'manual_license',
          title: 'Gumroad license',
          providerProductRef,
        },
      ],
    });

    const result = await t.action(api.verificationIntents.verifyIntentWithManualLicense, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      intentId,
      methodKey: 'gumroad-license',
      licenseKey: 'license_123',
    });

    expect(result).toEqual({ success: true });
    expect(requestCount).toBe(1);
  });

  it('verifies manual-license intents for Backstage delivery packages without legacy package registration', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-manual-license-backstage-creator';
    const buyerAuthUserId = 'auth-manual-license-backstage-buyer';
    const packageId = 'com.yucp.backstage.manual-license';
    const productId = 'product-manual-license-backstage';
    const providerProductRef = 'QAJc7ErxdAC815P5P8R89g==';
    const encryptedAccessToken = await symmetricEncrypt({
      key: process.env.BETTER_AUTH_SECRET as string,
      data: 'gumroad-access-token',
    });
    let requestCount = 0;

    globalThis.fetch = async (input, init) => {
      requestCount += 1;
      expect(String(input)).toBe('https://api.gumroad.com/v2/licenses/verify');
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toContain('access_token=gumroad-access-token');
      expect(String(init?.body)).toContain(
        `product_id=${encodeURIComponent(providerProductRef)}`
      );
      expect(String(init?.body)).toContain('license_key=license_123');
      return new Response(
        JSON.stringify({
          success: true,
          purchase: {
            product_permalink: 'song-thing',
            email: 'buyer@example.com',
            sale_id: 'sale_456',
            refunded: false,
            chargebacked: false,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: creatorAuthUserId,
      productId,
      provider: 'gumroad',
      providerProductRef,
      displayName: 'Manual License Backstage Product',
    });

    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForProduct, {
      authUserId: creatorAuthUserId,
      catalogProductId,
      packageId,
      packageName: 'Manual License Backstage Package',
      displayName: 'Manual License Backstage Package',
      repositoryVisibility: 'hidden',
      defaultChannel: 'stable',
    });

    const connectionId = await t.mutation(api.providerConnections.createProviderConnection, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      providerKey: 'gumroad',
      authMode: 'oauth',
      label: 'Gumroad Store',
    });

    await t.mutation(api.providerConnections.putProviderCredential, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      providerConnectionId: connectionId,
      credentialKey: 'oauth_access_token',
      kind: 'oauth_access_token',
      encryptedValue: encryptedAccessToken,
    });

    const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      packageId,
      machineFingerprint: 'machine-manual-license-backstage',
      codeChallenge: 'challenge-manual-license-backstage',
      returnUrl: 'https://example.com/return',
      requirements: [
        {
          methodKey: 'gumroad-license',
          providerKey: 'gumroad',
          kind: 'manual_license',
          title: 'Gumroad license',
          providerProductRef,
          creatorAuthUserId,
          productId,
        },
      ],
    });

    const result = await t.action(api.verificationIntents.verifyIntentWithManualLicense, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      intentId,
      methodKey: 'gumroad-license',
      licenseKey: 'license_123',
    });

    expect(result).toEqual({ success: true });
    expect(requestCount).toBe(1);
  });

  it('preserves itch account-link product references across current and legacy intent shapes', async () => {
    const cases = [
      {
        name: 'current buyer-provider-link shape preserves inline creator context',
        authUserId: 'auth-itch-current-shape',
        requirement: {
          methodKey: 'itchio-link-current',
          providerKey: 'itchio',
          kind: 'buyer_provider_link' as const,
          title: 'Linked itch.io account',
          creatorAuthUserId: 'creator_current',
          productId: 'product_current',
          providerProductRef: 'current-game-id',
        },
        expectedRequirement: {
          methodKey: 'itchio-link-current',
          providerKey: 'itchio',
          kind: 'buyer_provider_link',
          creatorAuthUserId: 'creator_current',
          productId: 'product_current',
          providerProductRef: 'current-game-id',
        },
      },
      {
        name: 'legacy manual-license shape canonicalizes to buyer-provider-link while keeping providerProductRef',
        authUserId: 'auth-itch-legacy-shape',
        requirement: {
          methodKey: 'itchio-link-legacy',
          providerKey: 'itchio',
          kind: 'manual_license' as const,
          title: 'itch.io download key',
          providerProductRef: 'legacy-game-id',
        },
        expectedRequirement: {
          methodKey: 'itchio-link-legacy',
          providerKey: 'itchio',
          kind: 'buyer_provider_link',
          providerProductRef: 'legacy-game-id',
        },
      },
    ] as const;

    const t = makeTestConvex();
    for (const testCase of cases) {
      await seedSubject(t, {
        authUserId: testCase.authUserId,
        primaryDiscordUserId: `discord-${testCase.authUserId}`,
      });

      const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
        apiSecret: API_SECRET,
        authUserId: testCase.authUserId,
        packageId: `pkg-${testCase.authUserId}`,
        machineFingerprint: `machine-${testCase.authUserId}`,
        codeChallenge: `challenge-${testCase.authUserId}`,
        returnUrl: 'https://example.com/return',
        requirements: [testCase.requirement],
      });

      const storedIntent = await t.query(api.verificationIntents.getIntentRecord, {
        apiSecret: API_SECRET,
        authUserId: testCase.authUserId,
        intentId,
      });

      expect(storedIntent?.requirements, testCase.name).toMatchObject([
        testCase.expectedRequirement,
      ]);
    }
  });

  it('canonicalizes legacy manual-license requirements across provider capability permutations', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-manual-license-permutations';
    await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-manual-license-permutations',
    });

    const requirements = PROVIDER_REGISTRY.map((provider, index) => ({
      methodKey: `${provider.providerKey}-legacy-manual-license`,
      providerKey: provider.providerKey,
      kind: 'manual_license' as const,
      title: `${provider.label} proof`,
      providerProductRef: `product-${index}`,
    }));

    const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId,
      packageId: 'pkg-manual-license-permutations',
      machineFingerprint: 'machine-manual-license-permutations',
      codeChallenge: 'challenge-manual-license-permutations',
      returnUrl: 'https://example.com/return',
      requirements,
    });

    const storedIntent = await t.query(api.verificationIntents.getIntentRecord, {
      apiSecret: API_SECRET,
      authUserId,
      intentId,
    });

    expect(
      storedIntent?.requirements.map((requirement) => ({
        methodKey: requirement.methodKey,
        providerKey: requirement.providerKey,
        kind: requirement.kind,
        providerProductRef: requirement.providerProductRef ?? null,
      }))
    ).toEqual(
      PROVIDER_REGISTRY.map((provider, index) => ({
        methodKey: `${provider.providerKey}-legacy-manual-license`,
        providerKey: provider.providerKey,
        kind:
          provider.buyerVerificationMethods.includes('account_link') &&
          !provider.buyerVerificationMethods.includes('license_key')
            ? 'buyer_provider_link'
            : 'manual_license',
        providerProductRef: `product-${index}`,
      }))
    );
  });

  it('keeps the intent pending and reports provider_link_missing when no buyer link exists', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-buyer-link-missing';
    await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-buyer-link-missing',
    });

    const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId,
      packageId: 'pkg-buyer-link-missing',
      machineFingerprint: 'machine-missing',
      codeChallenge: 'challenge-missing',
      returnUrl: 'https://example.com/return',
      requirements: [
        {
          methodKey: 'vrchat-link',
          providerKey: 'vrchat',
          kind: 'buyer_provider_link',
          title: 'Linked VRChat account',
        },
      ],
    });

    const result = await t.action(api.verificationIntents.verifyIntentWithBuyerProviderLink, {
      apiSecret: API_SECRET,
      authUserId,
      intentId,
      methodKey: 'vrchat-link',
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('provider_link_missing');

    const intent = await t.query(api.verificationIntents.getIntentRecord, {
      apiSecret: API_SECRET,
      authUserId,
      intentId,
    });

    expect(intent?.status).toBe('pending');
    expect(intent?.errorCode).toBe('provider_link_missing');
  });

  it('refuses manual redemption after the resolved buyer subject becomes inactive without consuming or syncing', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-manual-inactive-subject-creator';
    const buyerAuthUserId = 'auth-manual-inactive-subject-buyer';
    const packageId = 'pkg.manual-inactive-subject';
    const productId = 'product-manual-inactive-subject';
    const licenseKey = 'manual-inactive-subject-license';
    const subjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-manual-inactive-subject',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId,
      packageName: 'Manual Inactive Subject Package',
      publisherId: 'publisher-manual-inactive-subject',
      yucpUserId: creatorAuthUserId,
    });
    await seedCatalogProduct(t, {
      authUserId: creatorAuthUserId,
      productId,
      provider: 'manual',
      providerProductRef: productId,
      displayName: 'Manual Inactive Subject Product',
    });
    const { licenseId } = await t.mutation(api.manualLicenses.create, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      licenseKeyHash: await hashManualLicenseKey(licenseKey),
      productId,
      maxUses: 1,
    });
    const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      packageId,
      machineFingerprint: 'machine-manual-inactive-subject',
      codeChallenge: 'challenge-manual-inactive-subject',
      returnUrl: 'https://example.com/return',
      requirements: [
        {
          methodKey: 'manual-license',
          providerKey: 'manual',
          kind: 'manual_license',
          title: 'Manual license',
          providerProductRef: productId,
          creatorAuthUserId,
          productId,
        },
      ],
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(subjectId, { status: 'suspended', updatedAt: Date.now() });
    });

    const result = await t.action(api.verificationIntents.verifyIntentWithManualLicense, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
      intentId,
      methodKey: 'manual-license',
      licenseKey,
    });
    const [license, entitlements, roleSyncJobs, persistedIntent] = await t.run(async (ctx) => {
      const currentLicense = await ctx.db.get(licenseId);
      const currentEntitlements = await ctx.db
        .query('entitlements')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', creatorAuthUserId).eq('subjectId', subjectId)
        )
        .collect();
      const currentRoleSyncJobs = await ctx.db
        .query('outbox_jobs')
        .withIndex('by_auth_user_type', (q) =>
          q.eq('authUserId', creatorAuthUserId).eq('jobType', 'role_sync')
        )
        .collect();
      const currentIntent = await ctx.db.get(intentId);
      return [currentLicense, currentEntitlements, currentRoleSyncJobs, currentIntent] as const;
    });

    expect({
      result,
      currentUses: license?.currentUses,
      entitlementCount: entitlements.length,
      roleSyncJobCount: roleSyncJobs.length,
      persistedFailure: {
        errorCode: persistedIntent?.errorCode,
        errorMessage: persistedIntent?.errorMessage,
      },
    }).toEqual({
      result: {
        success: false,
        errorCode: 'subject_inactive',
        errorMessage: 'The buyer subject is no longer active.',
      },
      currentUses: 0,
      entitlementCount: 0,
      roleSyncJobCount: 0,
      persistedFailure: {
        errorCode: 'subject_inactive',
        errorMessage: 'The buyer subject is no longer active.',
      },
    });
  });

  it('cascades manual-license revocation to redeemed entitlements and role-removal jobs exactly once', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-manual-revoke-cascade-creator';
    const packageId = 'pkg.manual-revoke-cascade';
    const productId = 'product-manual-revoke-cascade';
    const licenseKey = 'manual-revoke-cascade-license';
    const buyerSubjects = [
      {
        authUserId: 'auth-manual-revoke-cascade-buyer-one',
        subjectId: await seedSubject(t, {
          authUserId: 'auth-manual-revoke-cascade-buyer-one',
          primaryDiscordUserId: 'discord-manual-revoke-cascade-one',
        }),
      },
      {
        authUserId: 'auth-manual-revoke-cascade-buyer-two',
        subjectId: await seedSubject(t, {
          authUserId: 'auth-manual-revoke-cascade-buyer-two',
          primaryDiscordUserId: 'discord-manual-revoke-cascade-two',
        }),
      },
    ];
    const guildLinkId = await seedGuildLink(t, {
      authUserId: creatorAuthUserId,
      discordGuildId: 'guild-manual-revoke-cascade',
      installedByAuthUserId: creatorAuthUserId,
    });
    await seedRoleRule(t, guildLinkId, {
      authUserId: creatorAuthUserId,
      guildId: 'guild-manual-revoke-cascade',
      productId,
      verifiedRoleId: 'role-manual-revoke-cascade',
      removeOnRevoke: true,
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId,
      packageName: 'Manual Revoke Cascade Package',
      publisherId: 'publisher-manual-revoke-cascade',
      yucpUserId: creatorAuthUserId,
    });
    await seedCatalogProduct(t, {
      authUserId: creatorAuthUserId,
      productId,
      provider: 'manual',
      providerProductRef: productId,
      displayName: 'Manual Revoke Cascade Product',
    });
    const { licenseId } = await t.mutation(api.manualLicenses.create, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
      licenseKeyHash: await hashManualLicenseKey(licenseKey),
      productId,
      maxUses: buyerSubjects.length,
    });
    const intentIds = [];
    for (const [index, buyer] of buyerSubjects.entries()) {
      const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
        apiSecret: API_SECRET,
        authUserId: buyer.authUserId,
        packageId,
        machineFingerprint: `machine-manual-revoke-cascade-${index}`,
        codeChallenge: `challenge-manual-revoke-cascade-${index}`,
        returnUrl: 'https://example.com/return',
        requirements: [
          {
            methodKey: 'manual-license',
            providerKey: 'manual',
            kind: 'manual_license',
            title: 'Manual license',
            providerProductRef: productId,
            creatorAuthUserId,
            productId,
          },
        ],
      });
      intentIds.push(intentId);
    }

    for (const [index, buyer] of buyerSubjects.entries()) {
      expect(
        await t.action(api.verificationIntents.verifyIntentWithManualLicense, {
          apiSecret: API_SECRET,
          authUserId: buyer.authUserId,
          intentId: intentIds[index],
          methodKey: 'manual-license',
          licenseKey,
        })
      ).toEqual({ success: true });
    }

    const sourceReference = `manual:${await sha256Hex(String(licenseId))}`;
    const activeEntitlements = await t.run(async (ctx) =>
      ctx.db
        .query('entitlements')
        .withIndex('by_auth_user_source_provider_reference_status', (q) =>
          q
            .eq('authUserId', creatorAuthUserId)
            .eq('sourceProvider', 'manual')
            .eq('sourceReference', sourceReference)
            .eq('status', 'active')
        )
        .collect()
    );
    expect(activeEntitlements.map((entitlement) => entitlement.subjectId).sort()).toEqual(
      buyerSubjects.map((buyer) => buyer.subjectId).sort()
    );
    const unrelatedEntitlementId = await seedEntitlement(t, buyerSubjects[0].subjectId, {
      authUserId: creatorAuthUserId,
      productId,
      sourceProvider: 'manual',
      sourceReference: 'manual:unrelated-license',
    });

    vi.useFakeTimers();
    try {
      await t.mutation(api.manualLicenses.revoke, {
        apiSecret: API_SECRET,
        authUserId: creatorAuthUserId,
        licenseId,
        reason: 'creator requested removal',
      });
      vi.runAllTimers();
      await t.finishInProgressScheduledFunctions();
      await t.mutation(api.manualLicenses.revoke, {
        apiSecret: API_SECRET,
        authUserId: creatorAuthUserId,
        licenseId,
        reason: 'second revoke must be a no-op',
      });
      vi.runAllTimers();
      await t.finishInProgressScheduledFunctions();
    } finally {
      vi.useRealTimers();
    }

    const [
      revokedEntitlements,
      unrelatedEntitlement,
      revokedLicense,
      roleRemovalJobs,
      revocationAuditEvents,
    ] = await t.run(async (ctx) => {
        const currentEntitlements = await ctx.db
          .query('entitlements')
          .withIndex('by_auth_user_source_provider_reference_status', (q) =>
            q
              .eq('authUserId', creatorAuthUserId)
              .eq('sourceProvider', 'manual')
              .eq('sourceReference', sourceReference)
          )
          .collect();
        const entitlementIds = new Set(currentEntitlements.map((entitlement) => entitlement._id));
        const currentUnrelatedEntitlement = await ctx.db.get(unrelatedEntitlementId);
        const currentLicense = await ctx.db.get(licenseId);
        const currentRoleRemovalJobs = await ctx.db
          .query('outbox_jobs')
          .withIndex('by_auth_user_type', (q) =>
            q.eq('authUserId', creatorAuthUserId).eq('jobType', 'role_removal')
          )
          .collect();
        const currentRevocationAuditEvents = await ctx.db
          .query('audit_events')
          .withIndex('by_auth_user_event', (q) =>
            q.eq('authUserId', creatorAuthUserId).eq('eventType', 'entitlement.revoked')
          )
          .collect();
        return [
          currentEntitlements,
          currentUnrelatedEntitlement,
          currentLicense,
          currentRoleRemovalJobs,
          currentRevocationAuditEvents.filter(
            (event) => event.entitlementId !== undefined && entitlementIds.has(event.entitlementId)
          ),
        ] as const;
      });

    expect({
      entitlementStatuses: revokedEntitlements.map((entitlement) => entitlement.status).sort(),
      revokedCount: revokedEntitlements.filter((entitlement) => entitlement.revokedAt !== undefined).length,
      unrelatedEntitlementStatus: unrelatedEntitlement?.status,
      licenseStatus: revokedLicense?.status,
      licenseNotes: revokedLicense?.notes,
      roleRemovalJobs: roleRemovalJobs.map((job) => ({
        subjectId: job.payload.subjectId,
        entitlementId: job.payload.entitlementId,
        guildId: job.payload.guildId,
        roleId: job.payload.roleId,
      })),
      auditEntitlementIds: revocationAuditEvents
        .map((event) => event.entitlementId)
        .filter((entitlementId): entitlementId is NonNullable<typeof entitlementId> =>
          Boolean(entitlementId)
        )
        .sort(),
    }).toEqual({
      entitlementStatuses: ['revoked', 'revoked'],
      revokedCount: buyerSubjects.length,
      unrelatedEntitlementStatus: 'active',
      licenseStatus: 'revoked',
      licenseNotes: 'Revoked: creator requested removal',
      roleRemovalJobs: [
        {
          subjectId: buyerSubjects[0].subjectId,
          entitlementId: activeEntitlements[0]?._id,
          guildId: 'guild-manual-revoke-cascade',
          roleId: 'role-manual-revoke-cascade',
        },
        {
          subjectId: buyerSubjects[1].subjectId,
          entitlementId: activeEntitlements[1]?._id,
          guildId: 'guild-manual-revoke-cascade',
          roleId: 'role-manual-revoke-cascade',
        },
      ],
      auditEntitlementIds: activeEntitlements.map((entitlement) => entitlement._id).sort(),
    });
  });

  it('lists and revokes buyer provider links for account surfaces', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-buyer-link-list';
    const subjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-buyer-link-list',
    });
    const externalAccountId = await seedExternalAccount(t, {
      provider: 'vrchat',
      providerUserId: 'vrchat-user-456',
      providerUsername: 'BuyerLink',
    });

    const linkId = await t.mutation(api.subjects.upsertBuyerProviderLink, {
      apiSecret: API_SECRET,
      subjectId,
      provider: 'vrchat',
      externalAccountId,
      verificationMethod: 'account_link',
    });

    const linksBeforeRevoke = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId,
    });

    expect(linksBeforeRevoke).toHaveLength(1);
    expect(linksBeforeRevoke[0]).toMatchObject({
      id: linkId,
      provider: 'vrchat',
      providerUserId: 'vrchat-user-456',
      providerUsername: 'BuyerLink',
      verificationMethod: 'account_link',
      status: 'active',
    });

    const revokeResult = await t.mutation(api.subjects.revokeBuyerProviderLink, {
      apiSecret: API_SECRET,
      authUserId,
      linkId,
    });

    expect(revokeResult.success).toBe(true);

    const linksAfterRevoke = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId,
    });
    expect(linksAfterRevoke).toHaveLength(0);
  });

  it('keeps a disconnected buyer provider link revoked after reconciliation runs again', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-buyer-link-disconnect';
    const subjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-buyer-link-disconnect',
    });
    const externalAccountId = await seedExternalAccount(t, {
      provider: 'vrchat',
      providerUserId: 'vrchat-user-disconnect',
      providerUsername: 'DisconnectMe',
    });

    const bindingId = await seedVerificationBinding(t, {
      authUserId,
      subjectId,
      externalAccountId,
    });

    const linkId = await t.mutation(api.subjects.upsertBuyerProviderLink, {
      apiSecret: API_SECRET,
      subjectId,
      provider: 'vrchat',
      externalAccountId,
      verificationMethod: 'account_link',
    });

    const revokeResult = await t.mutation(api.subjects.revokeBuyerProviderLink, {
      apiSecret: API_SECRET,
      authUserId,
      linkId,
    });

    expect(revokeResult.success).toBe(true);

    await t.mutation(api.subjects.reconcileBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId,
    });

    const linksAfterReconcile = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId,
    });
    expect(linksAfterReconcile).toHaveLength(0);

    const binding = await t.run(async (ctx) => ctx.db.get(bindingId));
    expect(binding?.status).toBe('revoked');
  });

  it('lists buyer provider links across every active subject for the auth user', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-buyer-link-multi-subject';
    const primarySubjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-buyer-link-primary',
    });
    const secondarySubjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-buyer-link-secondary',
    });

    const gumroadAccountId = await seedExternalAccount(t, {
      provider: 'gumroad',
      providerUserId: 'gumroad-user-123',
      providerUsername: 'PrimaryBuyer',
    });
    const jinxxyAccountId = await seedExternalAccount(t, {
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-456',
      providerUsername: 'SecondaryBuyer',
    });

    await t.mutation(api.subjects.upsertBuyerProviderLink, {
      apiSecret: API_SECRET,
      subjectId: primarySubjectId,
      provider: 'gumroad',
      externalAccountId: gumroadAccountId,
      verificationMethod: 'oauth',
    });
    await t.mutation(api.subjects.upsertBuyerProviderLink, {
      apiSecret: API_SECRET,
      subjectId: secondarySubjectId,
      provider: 'jinxxy',
      externalAccountId: jinxxyAccountId,
      verificationMethod: 'account_link',
    });

    const links = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId,
    });

    expect(links.map((link: (typeof links)[number]) => link.provider).sort()).toEqual([
      'gumroad',
      'jinxxy',
    ]);
    expect(links.find((link: (typeof links)[number]) => link.provider === 'jinxxy')).toMatchObject({
      providerUserId: 'jinxxy-user-456',
      providerUsername: 'SecondaryBuyer',
      verificationMethod: 'account_link',
      status: 'active',
    });
  });
});

describe('verification intents redemption issuer', () => {
  beforeEach(async () => {
    process.env.CONVEX_API_SECRET = API_SECRET;
    process.env.CONVEX_SITE_URL = 'https://rare-squid-409.convex.site';
    await configurePinnedTestRoot();
  });

  it('mints the license token for the caller public origin instead of the convex site origin', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-redemption-issuer';
    const codeVerifier = 'code-verifier-redemption-issuer';
    const codeChallenge = await computeCodeChallenge(codeVerifier);
    const publicIssuerBaseUrl = 'https://public-api.test.example';

    await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-redemption-issuer',
    });

    const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId,
      packageId: 'pkg-redemption-issuer',
      packageName: 'Issuer Test Package',
      machineFingerprint: 'machine-redemption-issuer',
      codeChallenge,
      returnUrl: 'http://127.0.0.1:51515/callback',
      requirements: [
        {
          methodKey: 'vrchat-link',
          providerKey: 'vrchat',
          kind: 'buyer_provider_link',
          title: 'Linked VRChat buyer account',
        },
      ],
    });

    await t.mutation(internal.verificationIntents.markIntentVerified, {
      intentId,
      methodKey: 'vrchat-link',
    });

    const intent = await t.action(api.verificationIntents.getVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId,
      intentId,
    });

    const grantToken = intent?.grantToken;
    expect(grantToken).toBeTruthy();
    if (!grantToken) {
      throw new Error('Expected verification intent grant token');
    }

    const redemption = await t.action(api.verificationIntents.redeemVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId,
      intentId,
      codeVerifier,
      machineFingerprint: 'machine-redemption-issuer',
      grantToken,
      issuerBaseUrl: publicIssuerBaseUrl,
    });

    expect(redemption.success).toBe(true);
    const redemptionToken = redemption.token;
    expect(redemptionToken).toBeTruthy();
    if (!redemptionToken) {
      throw new Error('Expected redeemed verification token');
    }

    const payload = decodeJwtPayload(redemptionToken);
    expect(payload.iss).toBe(`${publicIssuerBaseUrl}/api/auth`);
    expect(payload.iss).not.toBe('https://rare-squid-409.convex.site/api/auth');
  });
});
