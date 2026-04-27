import { createApiActorBinding } from '@yucp/shared/apiActor';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { makeTestConvex } from './testHelpers';

process.env.CONVEX_API_SECRET = 'test-secret';
process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';

async function createAuthUserActorBinding(authUserId: string) {
  const now = Date.now();
  return await createApiActorBinding(
    {
      version: 1,
      kind: 'auth_user',
      authUserId,
      source: 'session',
      scopes: [],
      issuedAt: now,
      expiresAt: now + 60_000,
    },
    process.env.INTERNAL_SERVICE_AUTH_SECRET as string
  );
}

async function seedCatalogProduct(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    authUserId?: string;
    productId?: string;
    provider?: Doc<'product_catalog'>['provider'];
    providerProductRef?: string;
    displayName?: string;
    status?: Doc<'product_catalog'>['status'];
  } = {}
): Promise<Id<'product_catalog'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('product_catalog', {
      authUserId: overrides.authUserId ?? 'auth-user-1',
      productId: overrides.productId ?? 'product-1',
      provider: overrides.provider ?? 'gumroad',
      providerProductRef: overrides.providerProductRef ?? 'gumroad-product-1',
      displayName: overrides.displayName ?? 'Creator Product',
      status: overrides.status ?? 'active',
      supportsAutoDiscovery: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedSubject(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    authUserId?: string;
    primaryDiscordUserId?: string;
  } = {}
): Promise<Id<'subjects'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('subjects', {
      authUserId: overrides.authUserId ?? 'auth-user-1',
      primaryDiscordUserId: overrides.primaryDiscordUserId ?? 'discord-user-1',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

describe('packageRegistry', () => {
  it('stores package names and lists owned packages with human metadata', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.gamma',
      packageName: 'Gamma Tools',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });
    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.alpha',
      packageName: 'Alpha Suite',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    const packages = await t.query(internal.packageRegistry.getRegistrationsByYucpUser, {
      yucpUserId: 'auth-user-1',
    });

    expect(
      packages.map((entry: Doc<'package_registry'>) => [entry.packageId, entry.packageName])
    ).toEqual([
      ['pkg.gamma', 'Gamma Tools'],
      ['pkg.alpha', 'Alpha Suite'],
    ]);
  });

  it('updates the registered package name when the same creator re-registers a package', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.creator-suite',
      packageName: 'Creator Suite',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.creator-suite',
      packageName: 'Creator Suite+',
      publisherId: 'publisher-2',
      yucpUserId: 'auth-user-1',
    });

    const registration = await t.query(internal.packageRegistry.getRegistration, {
      packageId: 'pkg.creator-suite',
    });

    expect(registration?.publisherId).toBe('publisher-2');
    expect(registration?.packageName).toBe('Creator Suite+');
  });

  it('does not disclose the owning creator when a different creator hits a package namespace conflict', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.namespace',
      packageName: 'Namespace Owner',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    const conflict = await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.namespace',
      packageName: 'Namespace Challenger',
      publisherId: 'publisher-2',
      yucpUserId: 'auth-user-2',
    });

    expect(conflict).toEqual({
      registered: false,
      conflict: true,
      archived: false,
    });
    expect('ownedBy' in conflict).toBe(false);
  });

  it('hides archived packages from coupling forensics package lists', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.active',
      packageName: 'Active Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });
    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.archived',
      packageName: 'Archived Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    const archived = await t.mutation(api.packageRegistry.archiveForAuthUser, {
      apiSecret: 'test-secret',
      actor: await createAuthUserActorBinding('auth-user-1'),
      authUserId: 'auth-user-1',
      packageId: 'pkg.archived',
    });

    expect(archived).toEqual({
      archived: true,
      packageId: 'pkg.archived',
    });

    const forensicsPackages = await t.query(
      api.couplingForensics.listOwnedPackageSummariesForAuthUser,
      {
        apiSecret: 'test-secret',
        authUserId: 'auth-user-1',
      }
    );

    expect(forensicsPackages.packages).toEqual([
      {
        packageId: 'pkg.active',
        packageName: 'Active Package',
        registeredAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it('blocks archived packages from being renamed or updated through package registration', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.archived',
      packageName: 'Archive Me',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    await t.mutation(api.packageRegistry.archiveForAuthUser, {
      apiSecret: 'test-secret',
      actor: await createAuthUserActorBinding('auth-user-1'),
      authUserId: 'auth-user-1',
      packageId: 'pkg.archived',
    });

    const renameResult = await t.mutation(api.packageRegistry.renameForAuthUser, {
      apiSecret: 'test-secret',
      actor: await createAuthUserActorBinding('auth-user-1'),
      authUserId: 'auth-user-1',
      packageId: 'pkg.archived',
      packageName: 'Should Fail',
    });

    expect(renameResult).toEqual({
      updated: false,
      reason: 'Archived packages cannot be updated. Restore the package before renaming it.',
    });

    const registerResult = await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.archived',
      packageName: 'Should Not Update',
      publisherId: 'publisher-2',
      yucpUserId: 'auth-user-1',
    });

    expect(registerResult).toEqual({
      registered: false,
      conflict: false,
      archived: true,
      reason:
        'Archived packages cannot be updated. Restore the package before signing or changing it.',
    });

    const registration = await t.query(internal.packageRegistry.getRegistration, {
      packageId: 'pkg.archived',
    });

    expect(registration?.packageName).toBe('Archive Me');
    expect(registration?.publisherId).toBe('publisher-1');
  });

  it('enriches creator product listings with linked Backstage package summaries', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-backstage',
      providerProductRef: 'gumroad-product-backstage',
      displayName: 'Backstage Product',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.backstage.product',
      packageName: 'Backstage Product',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForProduct, {
      authUserId: 'auth-user-1',
      catalogProductId,
      packageId: 'com.yucp.backstage.product',
      packageName: 'Backstage Product',
      displayName: 'Backstage Product',
      repositoryVisibility: 'listed',
      defaultChannel: 'stable',
    });

    await t.mutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.backstage.product',
      version: '1.2.3',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'listed',
      artifactKey: 'backstage-product-stable',
    });

    const result = await t.query(api.packageRegistry.listByAuthUser, {
      apiSecret: 'test-secret',
      actor: await createAuthUserActorBinding('auth-user-1'),
      authUserId: 'auth-user-1',
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      _id: catalogProductId,
      productId: 'product-backstage',
      displayName: 'Backstage Product',
      backstagePackages: [
        {
          packageId: 'com.yucp.backstage.product',
          packageName: 'Backstage Product',
          displayName: 'Backstage Product',
          status: 'active',
          repositoryVisibility: 'listed',
          defaultChannel: 'stable',
          latestPublishedVersion: '1.2.3',
          latestRelease: {
            version: '1.2.3',
            channel: 'stable',
            releaseStatus: 'published',
            repositoryVisibility: 'listed',
            artifactKey: 'backstage-product-stable',
          },
        },
      ],
    });
  });

  it('resolves entitled Backstage packages for a subject through active catalog entitlements', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-entitled',
      providerProductRef: 'gumroad-product-entitled',
      displayName: 'Entitled Product',
    });
    const subjectId = await seedSubject(t, {
      authUserId: 'auth-user-1',
      primaryDiscordUserId: 'discord-entitled-user',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.backstage.entitled',
      packageName: 'Entitled Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForProduct, {
      authUserId: 'auth-user-1',
      catalogProductId,
      packageId: 'com.yucp.backstage.entitled',
      packageName: 'Entitled Package',
      displayName: 'Entitled Package',
      repositoryVisibility: 'listed',
      defaultChannel: 'stable',
    });

    await t.mutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.backstage.entitled',
      version: '2.0.0',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'listed',
      artifactKey: 'entitled-package-stable',
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('entitlements', {
        authUserId: 'auth-user-1',
        subjectId,
        productId: 'product-entitled',
        sourceProvider: 'gumroad',
        sourceReference: 'order-1',
        catalogProductId,
        status: 'active',
        grantedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const entitledPackages = await t.query(
      internal.packageRegistry.listEntitledPackagesForSubject,
      {
        authUserId: 'auth-user-1',
        subjectId,
      }
    );

    expect(entitledPackages).toMatchObject([
      {
        catalogProductIds: [catalogProductId],
        packageId: 'com.yucp.backstage.entitled',
        packageName: 'Entitled Package',
        displayName: 'Entitled Package',
        latestPublishedVersion: '2.0.0',
        latestRelease: {
          version: '2.0.0',
          channel: 'stable',
          releaseStatus: 'published',
          repositoryVisibility: 'listed',
          artifactKey: 'entitled-package-stable',
        },
      },
    ]);
  });

  it('keeps multiple Backstage packages active for the same entitled catalog product', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-subscription',
      provider: 'patreon',
      providerProductRef: 'patreon-campaign-1',
      displayName: 'Subscription Product',
    });
    const subjectId = await seedSubject(t, {
      authUserId: 'auth-user-1',
      primaryDiscordUserId: 'discord-subscription-user',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.subscription.core',
      packageName: 'Subscription Core',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });
    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.subscription.addons',
      packageName: 'Subscription Addons',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForProduct, {
      authUserId: 'auth-user-1',
      catalogProductId,
      packageId: 'com.yucp.subscription.core',
      packageName: 'Subscription Core',
      displayName: 'Subscription Core',
      repositoryVisibility: 'listed',
      defaultChannel: 'stable',
    });
    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForProduct, {
      authUserId: 'auth-user-1',
      catalogProductId,
      packageId: 'com.yucp.subscription.addons',
      packageName: 'Subscription Addons',
      displayName: 'Subscription Addons',
      repositoryVisibility: 'listed',
      defaultChannel: 'stable',
    });

    await t.mutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.subscription.core',
      version: '1.0.0',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'listed',
      artifactKey: 'subscription-core-stable',
    });
    await t.mutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.subscription.addons',
      version: '1.0.0',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'listed',
      artifactKey: 'subscription-addons-stable',
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('entitlements', {
        authUserId: 'auth-user-1',
        subjectId,
        productId: 'product-subscription',
        sourceProvider: 'patreon',
        sourceReference: 'patreon:member:member-1:campaign:campaign-1',
        catalogProductId,
        status: 'active',
        grantedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const entitledPackages = await t.query(
      internal.packageRegistry.listEntitledPackagesForSubject,
      {
        authUserId: 'auth-user-1',
        subjectId,
      }
    );

    expect(entitledPackages.map((pkg) => pkg.packageId).sort()).toEqual([
      'com.yucp.subscription.addons',
      'com.yucp.subscription.core',
    ]);
  });

  it('resolves tier-gated Backstage packages from active subscription tier evidence', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'creator-tier-package';
    const buyerAuthUserId = 'buyer-tier-package';
    const subjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-tier-package-user',
    });

    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: creatorAuthUserId,
      productId: 'product-tier-package',
      provider: 'gumroad',
      providerProductRef: 'gumroad-tier-package',
      displayName: 'Tiered Subscription Product',
    });
    const catalogTierId = await t.mutation(api.catalogTiers.upsertCatalogTier, {
      apiSecret: 'test-secret',
      authUserId: creatorAuthUserId,
      provider: 'gumroad',
      productId: 'product-tier-package',
      catalogProductId,
      providerProductRef: 'gumroad-tier-package',
      providerTierRef:
        'gumroad|product|20:gumroad-tier-package|variant|4:tier|option|4:gold|recurrence|7:monthly',
      displayName: 'Gold Monthly',
      amountCents: 1500,
      currency: 'USD',
      status: 'active',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.subscription.gold',
      packageName: 'Gold Subscription Package',
      publisherId: 'publisher-1',
      yucpUserId: creatorAuthUserId,
    });
    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForAccessSelectors, {
      authUserId: creatorAuthUserId,
      accessSelectors: [{ kind: 'catalogTier', catalogTierId }],
      packageId: 'com.yucp.subscription.gold',
      packageName: 'Gold Subscription Package',
      displayName: 'Gold Subscription Package',
      repositoryVisibility: 'listed',
      defaultChannel: 'stable',
    });
    await t.mutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: creatorAuthUserId,
      packageId: 'com.yucp.subscription.gold',
      version: '1.0.0',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'listed',
      artifactKey: 'subscription-gold-stable',
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('purchase_facts', {
        authUserId: creatorAuthUserId,
        provider: 'gumroad',
        externalOrderId: 'sale-tier-package',
        providerProductId: 'gumroad-tier-package',
        externalVariantId:
          'gumroad|product|20:gumroad-tier-package|variant|4:tier|option|4:gold|recurrence|7:monthly',
        paymentStatus: 'paid',
        lifecycleStatus: 'active',
        purchasedAt: Date.now() - 60_000,
        subjectId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never);
      await ctx.db.insert('entitlements', {
        authUserId: creatorAuthUserId,
        subjectId,
        productId: 'product-tier-package',
        sourceProvider: 'gumroad',
        sourceReference: 'gumroad:sale-tier-package',
        catalogProductId,
        status: 'active',
        grantedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const entitledPackages = await t.query(
      internal.packageRegistry.listEntitledPackagesForSubject,
      {
        authUserId: creatorAuthUserId,
        subjectId,
      }
    );

    expect(entitledPackages.map((pkg) => pkg.packageId)).toEqual(['com.yucp.subscription.gold']);
  });

  it('builds a VPM-style Backstage Repos document from entitled packages', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-vpm',
      providerProductRef: 'gumroad-product-vpm',
      displayName: 'VPM Product',
    });
    const subjectId = await seedSubject(t, {
      authUserId: 'auth-user-1',
      primaryDiscordUserId: 'discord-vpm-user',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.backstage.vpm',
      packageName: 'VPM Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForProduct, {
      authUserId: 'auth-user-1',
      catalogProductId,
      packageId: 'com.yucp.backstage.vpm',
      packageName: 'VPM Package',
      displayName: 'VPM Package',
      repositoryVisibility: 'listed',
      defaultChannel: 'stable',
    });

    await t.mutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.backstage.vpm',
      version: '3.1.0',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'listed',
      artifactKey: 'vpm-package-stable',
      zipSha256: 'abcdef1234567890',
      metadata: {
        description: 'Private VPM package',
        dependencies: {
          'com.vrchat.base': '3.7.0',
        },
      },
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('entitlements', {
        authUserId: 'auth-user-1',
        subjectId,
        productId: 'product-vpm',
        sourceProvider: 'gumroad',
        sourceReference: 'order-vpm',
        catalogProductId,
        status: 'active',
        grantedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const repository = await t.query(internal.packageRegistry.buildBackstageRepositoryForSubject, {
      authUserId: 'auth-user-1',
      subjectId,
      repositoryUrl: 'https://api.yucp.test/v1/backstage/repos/index.json',
      packageBaseUrl: 'https://api.yucp.test/v1/backstage/package',
      packageHeaders: {
        'X-YUCP-Repo-Token': 'ybt_example',
      },
    });

    expect(repository).toMatchObject({
      name: 'Backstage Repos',
      author: 'YUCP',
      id: 'club.yucp.backstage.auth-user-1',
      url: 'https://api.yucp.test/v1/backstage/repos/index.json',
      packages: {
        'com.yucp.backstage.vpm': {
          versions: {
            '3.1.0': {
              name: 'com.yucp.backstage.vpm',
              version: '3.1.0',
              displayName: 'VPM Package',
              description: 'Private VPM package',
              dependencies: {
                'com.vrchat.base': '3.7.0',
              },
              headers: {
                'X-YUCP-Repo-Token': 'ybt_example',
              },
              zipSHA256: 'abcdef1234567890',
              yucpArtifactKey: 'vpm-package-stable',
            },
          },
        },
      },
    });
    const repositoryPackages = repository.packages as Record<
      string,
      { versions: Record<string, { url: string }> }
    >;
    expect(repositoryPackages['com.yucp.backstage.vpm'].versions['3.1.0'].url).toBe(
      'https://api.yucp.test/v1/backstage/package?packageId=com.yucp.backstage.vpm&version=3.1.0&channel=stable'
    );
  });

  it('issues revocable Backstage repo tokens for an authenticated subject', async () => {
    const t = makeTestConvex();
    const subjectId = await seedSubject(t, {
      authUserId: 'auth-user-1',
      primaryDiscordUserId: 'discord-token-user',
    });

    const result = await t.mutation(internal.packageRegistry.issueBackstageRepoToken, {
      authUserId: 'auth-user-1',
      subjectId,
      label: 'VCC desktop',
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });

    expect(result.token).toMatch(/^ybt_[0-9a-f]+$/);
    const access = await t.query(internal.packageRegistry.getBackstageRepoAccessByToken, {
      tokenHash: await crypto.subtle
        .digest('SHA-256', new TextEncoder().encode(result.token))
        .then((buffer) =>
          Array.from(new Uint8Array(buffer))
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('')
        ),
    });

    expect(access).toMatchObject({
      tokenId: result.tokenId,
      authUserId: 'auth-user-1',
      subjectId,
      status: 'active',
    });
  });
});
