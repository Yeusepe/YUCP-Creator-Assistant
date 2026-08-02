import type { WorkId } from '@convex-dev/workpool';
import {
  defineSchema,
  defineTable,
  type GenericActionCtx,
  type GenericMutationCtx,
} from 'convex/server';
import { v } from 'convex/values';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { DataModel } from './_generated/dataModel';
import { PII_PURPOSES } from './lib/credentialKeys';
import { encryptForPurpose } from './lib/vrchat/crypto';
import { roleSyncPool } from './roleSyncWorkpool';
import schema from './schema';
import { makeTestConvex } from './testHelpers';

type ComponentMutationCtx = GenericMutationCtx<DataModel> &
  Pick<GenericActionCtx<DataModel>, 'storage'>;

const TEST_WORK_ID = 'test-role-sync-work' as WorkId;

type ComponentAwareTestConvex = ReturnType<typeof makeTestConvex> & {
  runInComponent: <Output>(
    componentPath: string,
    handler: (ctx: ComponentMutationCtx) => Promise<Output>
  ) => Promise<Output>;
};

type TestImportMeta = ImportMeta & {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
};

describe('provider license intent entitlement remediation', () => {
  it('attaches unambiguous catalog identities to active provider entitlements and evidence', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const authUserId = 'creator-entitlement-catalog-repair';
    const subjectId = await t.run(async (ctx) => {
      return await ctx.db.insert('subjects', {
        authUserId: 'buyer-entitlement-catalog-repair',
        primaryDiscordUserId: 'discord-entitlement-catalog-repair',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });
    const catalogProductId = await t.run(async (ctx) => {
      return await ctx.db.insert('product_catalog', {
        authUserId,
        productId: 'logical-entitlement-catalog-repair',
        provider: 'jinxxy',
        providerProductRef: 'jinxxy-entitlement-catalog-repair',
        displayName: 'Entitlement Catalog Repair',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
    });
    const { entitlementId, evidenceId } = await t.run(async (ctx) => {
      const sourceReference = 'jinxxy:catalog-repair-order:catalog-repair-license';
      const entitlementId = await ctx.db.insert('entitlements', {
        authUserId,
        subjectId,
        productId: 'jinxxy-entitlement-catalog-repair',
        sourceProvider: 'jinxxy',
        sourceReference,
        status: 'active',
        grantedAt: now,
        updatedAt: now,
      });
      const evidenceId = await ctx.db.insert('entitlement_evidence', {
        authUserId,
        subjectId,
        providerKey: 'jinxxy',
        sourceReference,
        evidenceType: 'license_verification',
        status: 'active',
        productId: 'jinxxy-entitlement-catalog-repair',
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { entitlementId, evidenceId };
    });

    const result = await t.mutation(internal.migrations.repairEntitlementCatalogProductIds, {
      limit: 10,
    });
    const stored = await t.run(async (ctx) => ({
      entitlement: await ctx.db.get(entitlementId),
      evidence: await ctx.db.get(evidenceId),
    }));

    expect(result).toMatchObject({
      scanned: 1,
      repaired: 1,
      evidenceRepaired: 1,
      ambiguous: 0,
      unresolved: 0,
      isDone: true,
    });
    expect(stored.entitlement).toMatchObject({ catalogProductId });
    expect(stored.evidence).toMatchObject({ catalogProductId });
  });

  it('resets incomplete provider proofs and preserves verified intents with canonical entitlements', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const creatorAuthUserId = 'creator-provider-license-intent-repair';
    const productId = 'product-provider-license-intent-repair';
    const packageId = 'pkg.provider-license-intent-repair';
    const catalogProductId = await t.run(async (ctx) => {
      return await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId,
        provider: 'jinxxy',
        providerProductRef: 'jinxxy-provider-license-intent-repair',
        displayName: 'Provider License Intent Repair',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
    });
    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId,
      packageName: 'Provider License Intent Repair',
      publisherId: 'publisher-provider-license-intent-repair',
      yucpUserId: creatorAuthUserId,
    });

    const fixture = await t.run(async (ctx) => {
      const incompleteSubjectId = await ctx.db.insert('subjects', {
        authUserId: 'buyer-provider-license-intent-incomplete',
        primaryDiscordUserId: 'discord-provider-license-intent-incomplete',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const preservedSubjectId = await ctx.db.insert('subjects', {
        authUserId: 'buyer-provider-license-intent-preserved',
        primaryDiscordUserId: 'discord-provider-license-intent-preserved',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const expiredSubjectId = await ctx.db.insert('subjects', {
        authUserId: 'buyer-provider-license-intent-expired',
        primaryDiscordUserId: 'discord-provider-license-intent-expired',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const requirement = {
        methodKey: 'jinxxy-license',
        providerKey: 'jinxxy',
        kind: 'manual_license' as const,
        title: 'Jinxxy license',
        creatorAuthUserId,
        productId,
        providerProductRef: 'jinxxy-provider-license-intent-repair',
      };
      const incompleteIntentId = await ctx.db.insert('verification_intents', {
        authUserId: 'buyer-provider-license-intent-incomplete',
        subjectId: incompleteSubjectId,
        packageId,
        machineFingerprint: 'machine-provider-license-intent-incomplete',
        codeChallenge: 'challenge-provider-license-intent-incomplete',
        returnUrl: 'https://example.com/return',
        requirements: [requirement],
        status: 'verified',
        verifiedMethodKey: requirement.methodKey,
        verificationGrantJti: 'grant-provider-license-intent-incomplete',
        verificationGrantExpiresAt: now + 60_000,
        expiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      });
      const preservedIntentId = await ctx.db.insert('verification_intents', {
        authUserId: 'buyer-provider-license-intent-preserved',
        subjectId: preservedSubjectId,
        packageId,
        machineFingerprint: 'machine-provider-license-intent-preserved',
        codeChallenge: 'challenge-provider-license-intent-preserved',
        returnUrl: 'https://example.com/return',
        requirements: [requirement],
        status: 'verified',
        verifiedMethodKey: requirement.methodKey,
        verificationGrantJti: 'grant-provider-license-intent-preserved',
        verificationGrantExpiresAt: now + 60_000,
        expiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      });
      const expiredIntentId = await ctx.db.insert('verification_intents', {
        authUserId: 'buyer-provider-license-intent-expired',
        subjectId: expiredSubjectId,
        packageId,
        machineFingerprint: 'machine-provider-license-intent-expired',
        codeChallenge: 'challenge-provider-license-intent-expired',
        returnUrl: 'https://example.com/return',
        requirements: [requirement],
        status: 'verified',
        verifiedMethodKey: requirement.methodKey,
        verificationGrantJti: 'grant-provider-license-intent-expired',
        verificationGrantExpiresAt: now - 1,
        expiresAt: now - 1,
        createdAt: now - 120_000,
        updatedAt: now - 120_000,
      });
      await ctx.db.insert('entitlements', {
        authUserId: creatorAuthUserId,
        subjectId: preservedSubjectId,
        productId,
        catalogProductId,
        sourceProvider: 'jinxxy',
        sourceReference: 'jinxxy:preserved-order:preserved-license',
        status: 'active',
        grantedAt: now,
        updatedAt: now,
      });
      return { incompleteIntentId, preservedIntentId, expiredIntentId };
    });

    const result = await t.mutation(internal.migrations.resetIncompleteProviderLicenseIntents, {
      limit: 10,
    });
    const stored = await t.run(async (ctx) => ({
      incomplete: await ctx.db.get(fixture.incompleteIntentId),
      preserved: await ctx.db.get(fixture.preservedIntentId),
      expired: await ctx.db.get(fixture.expiredIntentId),
    }));

    expect(result).toMatchObject({
      scanned: 3,
      reset: 1,
      preserved: 1,
      expired: 1,
      isDone: true,
    });
    expect(stored.incomplete).toMatchObject({
      status: 'pending',
      errorCode: 'provider_license_reverification_required',
    });
    expect(stored.incomplete?.verifiedMethodKey).toBeUndefined();
    expect(stored.incomplete?.verificationGrantJti).toBeUndefined();
    expect(stored.incomplete?.verificationGrantExpiresAt).toBeUndefined();
    expect(stored.preserved).toMatchObject({
      status: 'verified',
      verifiedMethodKey: 'jinxxy-license',
    });
    expect(stored.expired).toMatchObject({
      status: 'expired',
      errorCode: 'expired',
    });
    expect(stored.expired?.verifiedMethodKey).toBeUndefined();
  });
});

async function seedBetterAuthDiscordAccount(
  t: ComponentAwareTestConvex,
  input: {
    authUserMarker: string;
    email: string;
    name: string;
    discordUserId: string;
  }
) {
  const now = Date.now();

  return await t.runInComponent('betterAuth', async (ctx) => {
    const componentDb = ctx.db as typeof ctx.db & {
      insert: (table: 'user' | 'account', value: Record<string, unknown>) => Promise<string>;
    };

    await componentDb.insert('user', {
      userId: input.authUserMarker,
      email: input.email,
      emailVerified: true,
      name: input.name,
      createdAt: now,
      updatedAt: now,
    });

    await componentDb.insert('account', {
      issuer: 'local:oauth:discord',
      providerAccountId: input.discordUserId,
      providerId: 'discord',
      userId: input.authUserMarker,
      createdAt: now,
      updatedAt: now,
    });

    return input.authUserMarker;
  });
}

describe('legacy license subject link hardening', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_SECRET = 'test-encryption-secret-32-bytes!!';
  });

  it('encrypts plaintext license keys on new writes and drops redundant purchaser emails', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.yucpLicenses.recordLicenseSubjectLink, {
      licenseSubject: 'a'.repeat(64),
      authUserId: 'auth-user-1',
      provider: 'gumroad',
      licenseKey: '11111111-2222-3333-4444-555555555555',
      purchaserEmail: 'buyer@example.com',
    });

    const stored = await t.run((ctx) =>
      ctx.db
        .query('license_subject_links')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', 'auth-user-1').eq('licenseSubject', 'a'.repeat(64))
        )
        .first()
    );

    expect(stored?.licenseKey).toBeUndefined();
    expect(stored?.licenseKeyEncrypted).toBeTruthy();
    expect(stored?.purchaserEmail).toBeUndefined();
  });

  it('migrates legacy plaintext license subject links in place', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const docId = await t.run(async (ctx) => {
      return await ctx.db.insert('license_subject_links', {
        licenseSubject: 'b'.repeat(64),
        authUserId: 'auth-user-2',
        provider: 'jinxxy',
        licenseKey: '22222222-3333-4444-5555-666666666666',
        purchaserEmail: 'legacy@example.com',
        createdAt: now,
      });
    });

    const result = await t.mutation(internal.migrations.migrateLegacyLicenseSubjectLinks, {});

    expect(result.updated).toBe(1);

    const stored = await t.run(async (ctx) => ctx.db.get(docId));
    expect(stored?.licenseKey).toBeUndefined();
    expect(stored?.licenseKeyEncrypted).toBeTruthy();
    expect(stored?.purchaserEmail).toBeUndefined();
  });
});

describe('entitlement evidence tier remediation', () => {
  let previousConvexApiSecret: string | undefined;

  beforeEach(() => {
    previousConvexApiSecret = process.env.CONVEX_API_SECRET;
    process.env.CONVEX_API_SECRET = 'test-secret';
  });

  afterEach(() => {
    if (previousConvexApiSecret === undefined) {
      delete process.env.CONVEX_API_SECRET;
    } else {
      process.env.CONVEX_API_SECRET = previousConvexApiSecret;
    }
  });

  it('repairs active entitlements with raw order ids and license source refs from purchase fact version evidence', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const { entitlementId, licenseRefEntitlementId, catalogTierId } = await t.run(async (ctx) => {
      const subjectId = await ctx.db.insert('subjects', {
        authUserId: 'buyer-remediate-tier-evidence',
        primaryDiscordUserId: 'discord-remediate-tier-evidence',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: 'creator-remediate-tier-evidence',
        productId: '3376661448741619269',
        provider: 'jinxxy',
        providerProductRef: '3376661448741619269',
        displayName: 'Tiered Jinxxy Product',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      const catalogTierId = await ctx.db.insert('catalog_tiers', {
        authUserId: 'creator-remediate-tier-evidence',
        provider: 'jinxxy',
        productId: '3376661448741619269',
        catalogProductId,
        providerProductRef: '3376661448741619269',
        providerTierRef: '3376663199720932937',
        displayName: 'Advanced Features',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('purchase_facts', {
        authUserId: 'creator-remediate-tier-evidence',
        provider: 'jinxxy',
        externalOrderId: '3923103452166620798',
        externalLineItemId: '3923103452175009407',
        providerProductId: '3376661448741619269',
        providerProductVersionId: '3376663199720932937',
        paymentStatus: 'paid',
        lifecycleStatus: 'active',
        purchasedAt: now - 60_000,
        subjectId,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('purchase_facts', {
        authUserId: 'creator-remediate-tier-evidence',
        provider: 'jinxxy',
        externalOrderId: 'order-with-license-ref',
        externalLineItemId: 'line-item-not-license-id',
        providerProductId: '3376661448741619269',
        providerProductVersionId: '3376663199720932937',
        paymentStatus: 'paid',
        lifecycleStatus: 'active',
        purchasedAt: now - 30_000,
        subjectId,
        createdAt: now,
        updatedAt: now,
      });
      const entitlementId = await ctx.db.insert('entitlements', {
        authUserId: 'creator-remediate-tier-evidence',
        subjectId,
        productId: '3376661448741619269',
        catalogProductId,
        sourceProvider: 'jinxxy',
        sourceReference: '3923103452166620798',
        status: 'active',
        grantedAt: now,
        updatedAt: now,
      });
      const licenseRefEntitlementId = await ctx.db.insert('entitlements', {
        authUserId: 'creator-remediate-tier-evidence',
        subjectId,
        productId: '3376661448741619269',
        catalogProductId,
        sourceProvider: 'jinxxy',
        sourceReference: 'jinxxy:order-with-license-ref:license-id-not-line-item',
        status: 'active',
        grantedAt: now,
        updatedAt: now,
      });

      return { entitlementId, licenseRefEntitlementId, catalogTierId };
    });

    const firstResult = await t.mutation(internal.migrations.repairEntitlementEvidenceTierRefs, {
      limit: 1,
    });

    expect(firstResult).toMatchObject({
      scanned: 1,
      repaired: 1,
      skipped: 0,
      remaining: 1,
      isDone: false,
    });
    expect(typeof firstResult.continueCursor).toBe('string');

    const secondResult = await t.mutation(internal.migrations.repairEntitlementEvidenceTierRefs, {
      cursor: firstResult.continueCursor,
      limit: 10,
    });

    expect(secondResult).toMatchObject({
      scanned: 1,
      repaired: 1,
      skipped: 0,
      remaining: 0,
      isDone: true,
    });

    const { rawEvidence, licenseRefEvidence } = await t.run(async (ctx) => {
      const rawEvidence = await ctx.db
        .query('entitlement_evidence')
        .withIndex('by_source_reference', (q) =>
          q.eq('providerKey', 'jinxxy').eq('sourceReference', '3923103452166620798')
        )
        .filter((q) => q.eq(q.field('authUserId'), 'creator-remediate-tier-evidence'))
        .first();
      const licenseRefEvidence = await ctx.db
        .query('entitlement_evidence')
        .withIndex('by_source_reference', (q) =>
          q
            .eq('providerKey', 'jinxxy')
            .eq('sourceReference', 'jinxxy:order-with-license-ref:license-id-not-line-item')
        )
        .filter((q) => q.eq(q.field('authUserId'), 'creator-remediate-tier-evidence'))
        .first();
      return { rawEvidence, licenseRefEvidence };
    });

    expect(rawEvidence).toMatchObject({
      providerTierRefs: ['3376663199720932937'],
      status: 'active',
      productId: '3376661448741619269',
    });
    expect(licenseRefEvidence).toMatchObject({
      providerTierRefs: ['3376663199720932937'],
      status: 'active',
      productId: '3376661448741619269',
    });

    const tierIds = await t.query(api.catalogTiers.getActiveCatalogTierIdsForEntitlement, {
      apiSecret: 'test-secret',
      entitlementId,
    });

    expect(tierIds).toEqual([catalogTierId]);
    const licenseRefTierIds = await t.query(
      api.catalogTiers.getActiveCatalogTierIdsForEntitlement,
      {
        apiSecret: 'test-secret',
        entitlementId: licenseRefEntitlementId,
      }
    );

    expect(licenseRefTierIds).toEqual([catalogTierId]);
  });

  it('replaces stale tier evidence with a purchase fact that resolves to the active catalog tier and queues a fresh sync', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const { entitlementId, subjectId } = await t.run(async (ctx) => {
      const subjectId = await ctx.db.insert('subjects', {
        authUserId: 'buyer-remediate-stale-tier-evidence',
        primaryDiscordUserId: 'discord-remediate-stale-tier-evidence',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: 'creator-remediate-stale-tier-evidence',
        productId: 'local-stale-tier-product',
        provider: 'jinxxy',
        providerProductRef: 'provider-stale-tier-product',
        displayName: 'Stale Tier Product',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('catalog_tiers', {
        authUserId: 'creator-remediate-stale-tier-evidence',
        provider: 'jinxxy',
        productId: 'local-stale-tier-product',
        catalogProductId,
        providerProductRef: 'provider-stale-tier-product',
        providerTierRef: 'canonical-product-version',
        displayName: 'Canonical Tier',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('purchase_facts', {
        authUserId: 'creator-remediate-stale-tier-evidence',
        provider: 'jinxxy',
        externalOrderId: 'stale-tier-order',
        providerProductId: 'provider-stale-tier-product',
        providerProductVersionId: 'canonical-product-version',
        paymentStatus: 'paid',
        lifecycleStatus: 'active',
        purchasedAt: now - 60_000,
        subjectId,
        createdAt: now,
        updatedAt: now,
      });
      const entitlementId = await ctx.db.insert('entitlements', {
        authUserId: 'creator-remediate-stale-tier-evidence',
        subjectId,
        productId: 'local-stale-tier-product',
        catalogProductId,
        sourceProvider: 'jinxxy',
        sourceReference: 'jinxxy:stale-tier-order',
        status: 'active',
        grantedAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('entitlement_evidence', {
        authUserId: 'creator-remediate-stale-tier-evidence',
        subjectId,
        providerKey: 'jinxxy',
        sourceReference: 'jinxxy:stale-tier-order',
        evidenceType: 'license_verification',
        status: 'active',
        productId: 'local-stale-tier-product',
        catalogProductId,
        providerTierRefs: ['inventory-target-version'],
        observedAt: now - 60_000,
        createdAt: now - 60_000,
        updatedAt: now - 60_000,
      });
      return { entitlementId, subjectId };
    });

    const result = await t.mutation(internal.migrations.repairEntitlementEvidenceTierRefs, {
      limit: 10,
    });

    expect(result).toMatchObject({
      scanned: 1,
      repaired: 1,
      skipped: 0,
      roleSyncJobsCreated: 1,
    });

    const { evidence, jobs } = await t.run(async (ctx) => ({
      evidence: await ctx.db
        .query('entitlement_evidence')
        .withIndex('by_source_reference', (q) =>
          q.eq('providerKey', 'jinxxy').eq('sourceReference', 'jinxxy:stale-tier-order')
        )
        .first(),
      jobs: await ctx.db
        .query('outbox_jobs')
        .withIndex('by_auth_user_type', (q) =>
          q.eq('authUserId', 'creator-remediate-stale-tier-evidence').eq('jobType', 'role_sync')
        )
        .collect(),
    }));

    expect(evidence?.providerTierRefs).toEqual(['canonical-product-version']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      subjectId,
      entitlementId,
      discordUserId: 'discord-remediate-stale-tier-evidence',
    });
  });

  it('lists every active tiered product supported by the provider backfill path', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    await t.run(async (ctx) => {
      for (const [productId, status, supportsAutoDiscovery, hasTier] of [
        ['tiered-active', 'active', true, true],
        ['tiered-manual', 'active', false, true],
        ['tiered-hidden', 'hidden', true, true],
        ['untiered-active', 'active', true, false],
      ] as const) {
        const catalogProductId = await ctx.db.insert('product_catalog', {
          authUserId: 'creator-tier-refresh',
          productId,
          provider: 'jinxxy',
          providerProductRef: `provider-${productId}`,
          displayName: productId,
          status,
          supportsAutoDiscovery,
          createdAt: now,
          updatedAt: now,
        });
        if (hasTier) {
          await ctx.db.insert('catalog_tiers', {
            authUserId: 'creator-tier-refresh',
            provider: 'jinxxy',
            productId,
            catalogProductId,
            providerProductRef: `provider-${productId}`,
            providerTierRef: `version-${productId}`,
            displayName: `${productId} tier`,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    });

    const batch = await t.query(internal.migrations.listTieredProductEvidenceRefreshBatch, {
      authUserId: 'creator-tier-refresh',
      provider: 'jinxxy',
      limit: 10,
    });

    expect(batch.products).toEqual([
      expect.objectContaining({
        productId: 'tiered-active',
        providerProductRef: 'provider-tiered-active',
      }),
      expect.objectContaining({
        productId: 'tiered-manual',
        providerProductRef: 'provider-tiered-manual',
      }),
    ]);
    expect(batch.isDone).toBe(true);
  });

  it('lists only tier-evidence failures that retain a decryptable license source', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const authUserId = 'creator-tier-license-reverification';
    const encryptionSecret = 'tier-license-reverification-secret';
    const licenseKeyEncrypted = await encryptForPurpose(
      'recoverable-license-key',
      encryptionSecret,
      PII_PURPOSES.forensicsLicenseKey
    );
    const subjectId = await t.run(async (ctx) =>
      ctx.db.insert('subjects', {
        authUserId: 'buyer-tier-license-reverification',
        primaryDiscordUserId: 'discord-tier-license-reverification',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
    );
    const catalogProductId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('product_catalog', {
        authUserId,
        productId: 'local-tier-license-product',
        provider: 'jinxxy',
        providerProductRef: 'provider-tier-license-product',
        displayName: 'Tier License Product',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('catalog_tiers', {
        authUserId,
        provider: 'jinxxy',
        productId: 'local-tier-license-product',
        catalogProductId: id,
        providerProductRef: 'provider-tier-license-product',
        providerTierRef: 'canonical-tier-license-version',
        displayName: 'Canonical Tier',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      return id;
    });

    const recoverableEntitlementId = await t.run(async (ctx) => {
      const recoverableEntitlementId = await ctx.db.insert('entitlements', {
        authUserId,
        subjectId,
        productId: 'local-tier-license-product',
        sourceProvider: 'jinxxy',
        sourceReference: 'jinxxy:license-reverification-order',
        licenseSubject: 'recoverable-license-subject',
        catalogProductId,
        status: 'active',
        grantedAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('license_subject_links', {
        authUserId,
        licenseSubject: 'recoverable-license-subject',
        provider: 'jinxxy',
        providerProductId: 'provider-tier-license-product',
        licenseKeyEncrypted,
        createdAt: now,
      });
      await ctx.db.insert('entitlements', {
        authUserId,
        subjectId,
        productId: 'local-tier-license-product',
        sourceProvider: 'jinxxy',
        sourceReference: 'jinxxy:unrecoverable-order',
        catalogProductId,
        status: 'active',
        grantedAt: now,
        updatedAt: now,
      });
      return recoverableEntitlementId;
    });

    const batch = await t.query(
      internal.migrations.listTierEvidenceLicenseReverificationBatch,
      { limit: 10 }
    );

    expect(batch.candidates).toEqual([
      expect.objectContaining({
        authUserId,
        subjectId,
        provider: 'jinxxy',
        providerProductRef: 'provider-tier-license-product',
        licenseKeyEncrypted,
      }),
    ]);
    expect(batch.isDone).toBe(true);

    const previousApiUrl = process.env.BACKFILL_API_URL;
    const previousEncryptionSecret = process.env.ENCRYPTION_SECRET;
    process.env.BACKFILL_API_URL = 'https://api.example.test';
    process.env.ENCRYPTION_SECRET = encryptionSecret;
    let persistTierEvidence = false;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        licenseKey: 'recoverable-license-key',
        provider: 'jinxxy',
        productId: 'provider-tier-license-product',
        authUserId,
        subjectId,
      });
      if (persistTierEvidence) {
        await t.run(async (ctx) => {
          await ctx.db.insert('entitlement_evidence', {
            authUserId,
            subjectId,
            providerKey: 'jinxxy',
            sourceReference: 'jinxxy:license-reverification-order',
            evidenceType: 'license_verification',
            status: 'active',
            productId: 'local-tier-license-product',
            catalogProductId,
            providerTierRefs: ['canonical-tier-license-version'],
            observedAt: now,
            createdAt: now,
            updatedAt: now,
          });
        });
      }
      return Response.json({ success: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const result = await t.action(internal.migrations.reverifyTierEvidenceLicenses, {
        limit: 10,
      });
      expect(result).toMatchObject({
        selected: 1,
        reverified: 0,
        failures: [
          expect.objectContaining({
            error: expect.stringContaining('did not persist matching tier evidence'),
          }),
        ],
        isDone: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      persistTierEvidence = true;
      const successfulResult = await t.action(
        internal.migrations.reverifyTierEvidenceLicenses,
        { limit: 10 }
      );
      expect(successfulResult).toMatchObject({
        selected: 1,
        reverified: 1,
        failures: [],
        isDone: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(
        await t.query(internal.migrations.isTierEvidenceResolvedForEntitlement, {
          entitlementId: recoverableEntitlementId,
        })
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      if (previousApiUrl === undefined) delete process.env.BACKFILL_API_URL;
      else process.env.BACKFILL_API_URL = previousApiUrl;
      if (previousEncryptionSecret === undefined) delete process.env.ENCRYPTION_SECRET;
      else process.env.ENCRYPTION_SECRET = previousEncryptionSecret;
    }
  });

  it('repairs shared-order entitlement evidence by product without patching sibling rows', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    await t.run(async (ctx) => {
      const subjectId = await ctx.db.insert('subjects', {
        authUserId: 'buyer-remediate-shared-order-tier-evidence',
        primaryDiscordUserId: 'discord-remediate-shared-order-tier-evidence',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const firstCatalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: 'creator-remediate-shared-order-tier-evidence',
        productId: 'provider-shared-first',
        provider: 'jinxxy',
        providerProductRef: 'provider-shared-first',
        displayName: 'Shared First Product',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      const secondCatalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: 'creator-remediate-shared-order-tier-evidence',
        productId: 'provider-shared-second',
        provider: 'jinxxy',
        providerProductRef: 'provider-shared-second',
        displayName: 'Shared Second Product',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      for (const [providerProductId, providerProductVersionId, externalLineItemId] of [
        ['provider-shared-first', 'version-shared-first', 'line-shared-first'],
        ['provider-shared-second', 'version-shared-second', 'line-shared-second'],
      ] as const) {
        await ctx.db.insert('purchase_facts', {
          authUserId: 'creator-remediate-shared-order-tier-evidence',
          provider: 'jinxxy',
          externalOrderId: 'shared-remediation-order',
          externalLineItemId,
          providerProductId,
          providerProductVersionId,
          paymentStatus: 'paid',
          lifecycleStatus: 'active',
          purchasedAt: now - 60_000,
          subjectId,
          createdAt: now,
          updatedAt: now,
        });
      }
      await ctx.db.insert('entitlements', {
        authUserId: 'creator-remediate-shared-order-tier-evidence',
        subjectId,
        productId: 'provider-shared-first',
        catalogProductId: firstCatalogProductId,
        sourceProvider: 'jinxxy',
        sourceReference: 'shared-remediation-order',
        status: 'active',
        grantedAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('entitlements', {
        authUserId: 'creator-remediate-shared-order-tier-evidence',
        subjectId,
        productId: 'provider-shared-second',
        catalogProductId: secondCatalogProductId,
        sourceProvider: 'jinxxy',
        sourceReference: 'shared-remediation-order',
        status: 'active',
        grantedAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('entitlement_evidence', {
        authUserId: 'creator-remediate-shared-order-tier-evidence',
        subjectId,
        providerKey: 'jinxxy',
        sourceReference: 'shared-remediation-order',
        evidenceType: 'license_verification',
        status: 'active',
        productId: 'provider-shared-second',
        catalogProductId: secondCatalogProductId,
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
    });

    const result = await t.mutation(internal.migrations.repairEntitlementEvidenceTierRefs, {
      limit: 10,
    });

    expect(result).toMatchObject({
      scanned: 2,
      repaired: 2,
      skipped: 0,
      remaining: 0,
      isDone: true,
    });

    const evidenceRows = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query('entitlement_evidence')
        .withIndex('by_source_reference', (q) =>
          q.eq('providerKey', 'jinxxy').eq('sourceReference', 'shared-remediation-order')
        )
        .filter((q) => q.eq(q.field('authUserId'), 'creator-remediate-shared-order-tier-evidence'))
        .collect();
      return rows.map((row) => ({
        productId: row.productId,
        providerTierRefs: row.providerTierRefs,
      }));
    });

    expect(evidenceRows).toHaveLength(2);
    expect(evidenceRows).toEqual(
      expect.arrayContaining([
        { productId: 'provider-shared-first', providerTierRefs: ['version-shared-first'] },
        { productId: 'provider-shared-second', providerTierRefs: ['version-shared-second'] },
      ])
    );
  });

  it('skips raw order remediation when multiple purchase facts can supply different tiers', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    await t.run(async (ctx) => {
      const subjectId = await ctx.db.insert('subjects', {
        authUserId: 'buyer-remediate-ambiguous-tier-evidence',
        primaryDiscordUserId: 'discord-remediate-ambiguous-tier-evidence',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      for (const [externalLineItemId, providerProductVersionId] of [
        ['line-item-basic', 'version-basic'],
        ['line-item-advanced', 'version-advanced'],
      ] as const) {
        await ctx.db.insert('purchase_facts', {
          authUserId: 'creator-remediate-ambiguous-tier-evidence',
          provider: 'jinxxy',
          externalOrderId: 'ambiguous-order',
          externalLineItemId,
          providerProductId: 'product-remediate-ambiguous-tier-evidence',
          providerProductVersionId,
          paymentStatus: 'paid',
          lifecycleStatus: 'active',
          purchasedAt: now - 60_000,
          subjectId,
          createdAt: now,
          updatedAt: now,
        });
      }
      await ctx.db.insert('entitlements', {
        authUserId: 'creator-remediate-ambiguous-tier-evidence',
        subjectId,
        productId: 'product-remediate-ambiguous-tier-evidence',
        sourceProvider: 'jinxxy',
        sourceReference: 'ambiguous-order',
        status: 'active',
        grantedAt: now,
        updatedAt: now,
      });
    });

    const result = await t.mutation(internal.migrations.repairEntitlementEvidenceTierRefs, {
      limit: 10,
    });

    expect(result).toMatchObject({
      scanned: 1,
      repaired: 0,
      skipped: 1,
      remaining: 0,
      isDone: true,
    });

    const evidence = await t.run((ctx) =>
      ctx.db
        .query('entitlement_evidence')
        .withIndex('by_source_reference', (q) =>
          q.eq('providerKey', 'jinxxy').eq('sourceReference', 'ambiguous-order')
        )
        .filter((q) => q.eq(q.field('authUserId'), 'creator-remediate-ambiguous-tier-evidence'))
        .first()
    );

    expect(evidence).toBeNull();
  });
});

describe('buyer attribution remediation', () => {
  it('detects verification bindings whose auth user does not match the buyer subject', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const buyerSubjectId = await t.run(async (ctx) => {
      return await ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-remediation-buyer-detect',
        authUserId: 'buyer-auth-detect',
        displayName: 'Remediation Buyer Detect',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });

    await t.run(async (ctx) => {
      const externalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'jinxxy',
        providerUserId: 'buyer-provider-detect',
        providerUsername: 'DetectedBuyer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('bindings', {
        authUserId: 'creator-auth-detect',
        subjectId: buyerSubjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: buyerSubjectId,
        reason: 'Legacy misattributed verification',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('buyer_provider_links', {
        subjectId: buyerSubjectId,
        provider: 'jinxxy',
        externalAccountId,
        verificationMethod: 'account_link',
        status: 'active',
        linkedAt: now,
        lastValidatedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('license_subject_links', {
        licenseSubject: 'detect-license-subject',
        authUserId: 'creator-auth-detect',
        provider: 'jinxxy',
        providerUserId: 'buyer-provider-detect',
        providerProductId: 'product-detect',
        licenseKeyEncrypted: 'encrypted-detect',
        createdAt: now,
      });
    });

    const report = await t.query(internal.migrations.listBuyerAttributionRemediationCandidates, {
      limit: 10,
    });

    expect(report.summary.candidateBindings).toBe(1);
    expect(report.summary.repairableBindings).toBe(1);
    expect(report.summary.repairableLicenseSubjectLinks).toBe(1);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]).toMatchObject({
      currentAuthUserId: 'creator-auth-detect',
      expectedBuyerAuthUserId: 'buyer-auth-detect',
      provider: 'jinxxy',
      providerUserId: 'buyer-provider-detect',
      relatedBuyerProviderLinks: [
        expect.objectContaining({
          subjectId: buyerSubjectId,
        }),
      ],
      relatedLicenseSubjectLinks: [
        expect.objectContaining({
          authUserId: 'creator-auth-detect',
          confidence: 'high',
          proposedAuthUserId: 'buyer-auth-detect',
          repairable: true,
        }),
      ],
    });
  });

  it('detects a misattributed buyer binding beyond the first scan batch', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const candidateBindingId = await t.run(async (ctx) => {
      const buyerSubjectId = await ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-remediation-buyer-paged',
        authUserId: 'buyer-auth-paged',
        displayName: 'Remediation Buyer Paged',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      const externalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'jinxxy',
        providerUserId: 'buyer-provider-paged',
        providerUsername: 'PagedBuyer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      const bindingId = await ctx.db.insert('bindings', {
        authUserId: 'creator-auth-paged',
        subjectId: buyerSubjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: buyerSubjectId,
        reason: 'Legacy misattributed verification',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      for (let index = 0; index < 60; index += 1) {
        const createdAt = now + index + 1;
        const subjectId = await ctx.db.insert('subjects', {
          primaryDiscordUserId: `discord-remediation-buyer-filler-${index}`,
          authUserId: `buyer-auth-filler-${index}`,
          displayName: `Remediation Buyer Filler ${index}`,
          status: 'active',
          createdAt,
          updatedAt: createdAt,
        });

        const fillerExternalAccountId = await ctx.db.insert('external_accounts', {
          provider: 'jinxxy',
          providerUserId: `buyer-provider-filler-${index}`,
          providerUsername: `FillerBuyer${index}`,
          status: 'active',
          createdAt,
          updatedAt: createdAt,
        });

        await ctx.db.insert('bindings', {
          authUserId: `buyer-auth-filler-${index}`,
          subjectId,
          externalAccountId: fillerExternalAccountId,
          bindingType: 'verification',
          status: 'active',
          createdBy: subjectId,
          reason: 'Healthy verification',
          version: 1,
          createdAt,
          updatedAt: createdAt,
        });
      }

      return bindingId;
    });

    const report = await t.query(internal.migrations.listBuyerAttributionRemediationCandidates, {
      limit: 1,
    });

    expect(report.summary.candidateBindings).toBe(1);
    expect(report.candidates).toEqual([
      expect.objectContaining({
        bindingId: candidateBindingId,
        currentAuthUserId: 'creator-auth-paged',
        expectedBuyerAuthUserId: 'buyer-auth-paged',
      }),
    ]);
  });

  it('repairs a selected binding, recreates a missing buyer provider link, and moves high-confidence license links', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const buyerSubjectId = await t.run(async (ctx) => {
      return await ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-remediation-buyer-repair',
        authUserId: 'buyer-auth-repair',
        displayName: 'Remediation Buyer Repair',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });

    const bindingId = await t.run(async (ctx) => {
      const externalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'jinxxy',
        providerUserId: 'buyer-provider-repair',
        providerUsername: 'RepairBuyer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('license_subject_links', {
        licenseSubject: 'repair-license-subject',
        authUserId: 'creator-auth-repair',
        provider: 'jinxxy',
        providerUserId: 'buyer-provider-repair',
        providerProductId: 'product-repair',
        licenseKeyEncrypted: 'encrypted-repair',
        createdAt: now,
      });

      return await ctx.db.insert('bindings', {
        authUserId: 'creator-auth-repair',
        subjectId: buyerSubjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: buyerSubjectId,
        reason: 'Legacy misattributed verification',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.mutation(internal.migrations.repairBuyerAttributionCandidates, {
      bindingIds: [bindingId],
    });

    expect(result).toMatchObject({
      repairedBindings: 1,
      repairedLicenseSubjectLinks: 1,
      createdBuyerProviderLinks: 1,
      skippedBindings: [],
    });

    const repairedBinding = await t.run(async (ctx) => ctx.db.get(bindingId));
    expect(repairedBinding?.authUserId).toBe('buyer-auth-repair');

    const createdLink = await t.run(async (ctx) =>
      ctx.db
        .query('buyer_provider_links')
        .withIndex('by_subject', (q) => q.eq('subjectId', buyerSubjectId))
        .first()
    );
    expect(createdLink).toMatchObject({
      subjectId: buyerSubjectId,
      provider: 'jinxxy',
      status: 'active',
    });

    const sourceLink = await t.run(async (ctx) =>
      ctx.db
        .query('license_subject_links')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', 'creator-auth-repair').eq('licenseSubject', 'repair-license-subject')
        )
        .first()
    );
    const repairedLicenseLink = await t.run(async (ctx) =>
      ctx.db
        .query('license_subject_links')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', 'buyer-auth-repair').eq('licenseSubject', 'repair-license-subject')
        )
        .first()
    );

    expect(sourceLink).toBeNull();
    expect(repairedLicenseLink).toMatchObject({
      authUserId: 'buyer-auth-repair',
      provider: 'jinxxy',
      providerUserId: 'buyer-provider-repair',
      providerProductId: 'product-repair',
      licenseKeyEncrypted: 'encrypted-repair',
    });
  });

  it('reactivates an existing revoked buyer provider link during remediation', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const { bindingId, externalAccountId, buyerSubjectId } = await t.run(async (ctx) => {
      const buyerSubjectId = await ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-remediation-buyer-revive',
        authUserId: 'buyer-auth-revive',
        displayName: 'Remediation Buyer Revive',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      const externalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'jinxxy',
        providerUserId: 'buyer-provider-revive',
        providerUsername: 'ReviveBuyer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('buyer_provider_links', {
        subjectId: buyerSubjectId,
        provider: 'jinxxy',
        externalAccountId,
        verificationMethod: 'account_link',
        status: 'revoked',
        linkedAt: now,
        lastValidatedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      const bindingId = await ctx.db.insert('bindings', {
        authUserId: 'creator-auth-revive',
        subjectId: buyerSubjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: buyerSubjectId,
        reason: 'Legacy misattributed verification',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      return { bindingId, externalAccountId, buyerSubjectId };
    });

    const result = await t.mutation(internal.migrations.repairBuyerAttributionCandidates, {
      bindingIds: [bindingId],
    });

    expect(result).toMatchObject({
      repairedBindings: 1,
      createdBuyerProviderLinks: 0,
      skippedBindings: [],
    });

    const repairedBinding = await t.run(async (ctx) => ctx.db.get(bindingId));
    const reactivatedLink = await t.run(async (ctx) =>
      ctx.db
        .query('buyer_provider_links')
        .withIndex('by_subject_external', (q) =>
          q.eq('subjectId', buyerSubjectId).eq('externalAccountId', externalAccountId)
        )
        .first()
    );

    expect(repairedBinding?.authUserId).toBe('buyer-auth-revive');
    expect(reactivatedLink).toMatchObject({
      subjectId: buyerSubjectId,
      externalAccountId,
      status: 'active',
    });
  });

  it('does not auto-move a shared provider-user license link when multiple buyers collide', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const { firstBindingId, secondBindingId } = await t.run(async (ctx) => {
      const firstBuyerSubjectId = await ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-remediation-buyer-collision-a',
        authUserId: 'buyer-auth-collision-a',
        displayName: 'Remediation Buyer Collision A',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const secondBuyerSubjectId = await ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-remediation-buyer-collision-b',
        authUserId: 'buyer-auth-collision-b',
        displayName: 'Remediation Buyer Collision B',
        status: 'active',
        createdAt: now + 1,
        updatedAt: now + 1,
      });

      const firstExternalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'jinxxy',
        providerUserId: 'shared-provider-user',
        providerUsername: 'CollisionBuyerA',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const secondExternalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'jinxxy',
        providerUserId: 'shared-provider-user',
        providerUsername: 'CollisionBuyerB',
        status: 'active',
        createdAt: now + 1,
        updatedAt: now + 1,
      });

      await ctx.db.insert('license_subject_links', {
        licenseSubject: 'collision-license-subject',
        authUserId: 'creator-auth-collision',
        provider: 'jinxxy',
        providerUserId: 'shared-provider-user',
        providerProductId: 'product-collision',
        licenseKeyEncrypted: 'encrypted-collision',
        createdAt: now,
      });

      const firstBindingId = await ctx.db.insert('bindings', {
        authUserId: 'creator-auth-collision',
        subjectId: firstBuyerSubjectId,
        externalAccountId: firstExternalAccountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: firstBuyerSubjectId,
        reason: 'Legacy misattributed verification',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const secondBindingId = await ctx.db.insert('bindings', {
        authUserId: 'creator-auth-collision',
        subjectId: secondBuyerSubjectId,
        externalAccountId: secondExternalAccountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: secondBuyerSubjectId,
        reason: 'Legacy misattributed verification',
        version: 1,
        createdAt: now + 1,
        updatedAt: now + 1,
      });

      return { firstBindingId, secondBindingId };
    });

    const report = await t.query(internal.migrations.listBuyerAttributionRemediationCandidates, {
      limit: 10,
    });

    expect(report.candidates).toHaveLength(2);
    expect(report.candidates.flatMap((candidate) => candidate.relatedLicenseSubjectLinks)).toEqual([
      expect.objectContaining({
        licenseSubject: 'collision-license-subject',
        confidence: 'high',
        repairable: false,
      }),
      expect.objectContaining({
        licenseSubject: 'collision-license-subject',
        confidence: 'high',
        repairable: false,
      }),
    ]);

    const result = await t.mutation(internal.migrations.repairBuyerAttributionCandidates, {
      bindingIds: [firstBindingId, secondBindingId],
    });

    expect(result).toMatchObject({
      repairedBindings: 2,
      repairedLicenseSubjectLinks: 0,
      skippedBindings: [],
    });

    const preservedLink = await t.run(async (ctx) =>
      ctx.db
        .query('license_subject_links')
        .withIndex('by_auth_user_subject', (q) =>
          q
            .eq('authUserId', 'creator-auth-collision')
            .eq('licenseSubject', 'collision-license-subject')
        )
        .first()
    );
    expect(preservedLink).not.toBeNull();
  });

  it('does not auto-move ambiguous license subject links', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const buyerSubjectId = await t.run(async (ctx) => {
      return await ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-remediation-buyer-ambiguous',
        authUserId: 'buyer-auth-ambiguous',
        displayName: 'Remediation Buyer Ambiguous',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });

    const bindingId = await t.run(async (ctx) => {
      const externalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'jinxxy',
        providerUserId: 'buyer-provider-ambiguous',
        providerUsername: 'AmbiguousBuyer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('license_subject_links', {
        licenseSubject: 'ambiguous-license-subject',
        authUserId: 'creator-auth-ambiguous',
        provider: 'jinxxy',
        providerProductId: 'product-ambiguous',
        licenseKeyEncrypted: 'encrypted-ambiguous',
        createdAt: now,
      });

      return await ctx.db.insert('bindings', {
        authUserId: 'creator-auth-ambiguous',
        subjectId: buyerSubjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: buyerSubjectId,
        reason: 'Legacy misattributed verification',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    });

    const report = await t.query(internal.migrations.listBuyerAttributionRemediationCandidates, {
      limit: 10,
    });

    expect(report.candidates[0].relatedLicenseSubjectLinks).toEqual([
      expect.objectContaining({
        confidence: 'medium',
        repairable: false,
      }),
    ]);

    const result = await t.mutation(internal.migrations.repairBuyerAttributionCandidates, {
      bindingIds: [bindingId],
    });

    expect(result).toMatchObject({
      repairedBindings: 1,
      repairedLicenseSubjectLinks: 0,
      skippedBindings: [],
    });

    const sourceLink = await t.run(async (ctx) =>
      ctx.db
        .query('license_subject_links')
        .withIndex('by_auth_user_subject', (q) =>
          q
            .eq('authUserId', 'creator-auth-ambiguous')
            .eq('licenseSubject', 'ambiguous-license-subject')
        )
        .first()
    );
    expect(sourceLink).not.toBeNull();
  });

  it('revokes the legacy binding instead of creating a duplicate when a buyer-scoped binding already exists', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const buyerSubjectId = await t.run(async (ctx) => {
      return await ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-remediation-buyer-duplicate',
        authUserId: 'buyer-auth-duplicate',
        displayName: 'Remediation Buyer Duplicate',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });

    const { legacyBindingId, existingBuyerBindingId } = await t.run(async (ctx) => {
      const externalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'jinxxy',
        providerUserId: 'buyer-provider-duplicate',
        providerUsername: 'DuplicateBuyer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      const legacyBindingId = await ctx.db.insert('bindings', {
        authUserId: 'creator-auth-duplicate',
        subjectId: buyerSubjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: buyerSubjectId,
        reason: 'Legacy misattributed verification',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      const existingBuyerBindingId = await ctx.db.insert('bindings', {
        authUserId: 'buyer-auth-duplicate',
        subjectId: buyerSubjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: buyerSubjectId,
        reason: 'Buyer re-verified after the bug fix',
        version: 1,
        createdAt: now + 1,
        updatedAt: now + 1,
      });

      return { legacyBindingId, existingBuyerBindingId };
    });

    const result = await t.mutation(internal.migrations.repairBuyerAttributionCandidates, {
      bindingIds: [legacyBindingId],
    });

    expect(result).toMatchObject({
      repairedBindings: 1,
      skippedBindings: [],
    });

    const legacyBinding = await t.run(async (ctx) => ctx.db.get(legacyBindingId));
    const existingBuyerBinding = await t.run(async (ctx) => ctx.db.get(existingBuyerBindingId));
    const buyerBindings = await t.run(async (ctx) =>
      ctx.db
        .query('bindings')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', 'buyer-auth-duplicate').eq('subjectId', buyerSubjectId)
        )
        .collect()
    );

    expect(legacyBinding).toMatchObject({
      authUserId: 'creator-auth-duplicate',
      status: 'revoked',
      reason: 'Merged into buyer-scoped verification binding during remediation',
    });
    expect(existingBuyerBinding).toMatchObject({
      authUserId: 'buyer-auth-duplicate',
      status: 'active',
    });
    expect(buyerBindings).toHaveLength(1);
  });

  it('ignores revoked buyer-scoped duplicates and repairs the live legacy binding', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const { legacyBindingId, revokedBuyerBindingId, buyerSubjectId } = await t.run(async (ctx) => {
      const buyerSubjectId = await ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-remediation-buyer-revoked-duplicate',
        authUserId: 'buyer-auth-revoked-duplicate',
        displayName: 'Remediation Buyer Revoked Duplicate',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      const externalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'jinxxy',
        providerUserId: 'buyer-provider-revoked-duplicate',
        providerUsername: 'RevokedDuplicateBuyer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      const legacyBindingId = await ctx.db.insert('bindings', {
        authUserId: 'creator-auth-revoked-duplicate',
        subjectId: buyerSubjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: buyerSubjectId,
        reason: 'Legacy misattributed verification',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      const revokedBuyerBindingId = await ctx.db.insert('bindings', {
        authUserId: 'buyer-auth-revoked-duplicate',
        subjectId: buyerSubjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'revoked',
        createdBy: buyerSubjectId,
        reason: 'Old buyer verification that was later revoked',
        version: 1,
        createdAt: now + 1,
        updatedAt: now + 1,
      });

      return { legacyBindingId, revokedBuyerBindingId, buyerSubjectId };
    });

    const result = await t.mutation(internal.migrations.repairBuyerAttributionCandidates, {
      bindingIds: [legacyBindingId],
    });

    expect(result).toMatchObject({
      repairedBindings: 1,
      skippedBindings: [],
    });

    const repairedBinding = await t.run(async (ctx) => ctx.db.get(legacyBindingId));
    const revokedBuyerBinding = await t.run(async (ctx) => ctx.db.get(revokedBuyerBindingId));
    const buyerBindings = await t.run(async (ctx) =>
      ctx.db
        .query('bindings')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', 'buyer-auth-revoked-duplicate').eq('subjectId', buyerSubjectId)
        )
        .collect()
    );

    expect(repairedBinding).toMatchObject({
      authUserId: 'buyer-auth-revoked-duplicate',
      status: 'active',
    });
    expect(revokedBuyerBinding).toMatchObject({
      authUserId: 'buyer-auth-revoked-duplicate',
      status: 'revoked',
    });
    expect(buyerBindings).toHaveLength(2);
  });
});

describe('subject ownership remediation', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_SECRET = 'test-encryption-secret-32-bytes!!';
    process.env.CONVEX_API_SECRET = 'test-secret';
  });

  it('detects subjects whose auth owner disagrees with the Better Auth Discord owner', async () => {
    const t = makeTestConvex() as ComponentAwareTestConvex;
    const now = Date.now();

    await seedBetterAuthDiscordAccount(t, {
      authUserMarker: 'buyer-auth-subject-detect',
      email: 'buyer-subject-detect@example.com',
      name: 'Buyer Subject Detect',
      discordUserId: 'discord-subject-detect',
    });

    const subjectId = await t.run(async (ctx) => {
      return await ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-subject-detect',
        authUserId: 'creator-auth-subject-detect',
        displayName: 'Wrongly Owned Buyer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });

    await t.run(async (ctx) => {
      const externalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'gumroad',
        providerUserId: 'subject-detect-gumroad-user',
        providerUsername: 'SubjectDetectBuyer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('buyer_provider_links', {
        subjectId,
        provider: 'gumroad',
        externalAccountId,
        verificationMethod: 'account_link',
        status: 'active',
        linkedAt: now,
        lastValidatedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });

    const report = await t.query(internal.migrations.listSubjectOwnershipRemediationCandidates, {
      limit: 10,
    });

    expect(report.summary.candidateSubjects).toBe(1);
    expect(report.summary.repairableSubjects).toBe(1);
    expect(report.candidates).toEqual([
      expect.objectContaining({
        subjectId,
        currentAuthUserId: 'creator-auth-subject-detect',
        expectedAuthUserId: 'buyer-auth-subject-detect',
        resolution: 'better_auth',
        repairable: true,
      }),
    ]);
  });

  it('detects a wrongly owned subject beyond the first scan batch', async () => {
    const t = makeTestConvex() as ComponentAwareTestConvex;
    const now = Date.now();

    await seedBetterAuthDiscordAccount(t, {
      authUserMarker: 'buyer-auth-subject-paged',
      email: 'buyer-subject-paged@example.com',
      name: 'Buyer Subject Paged',
      discordUserId: 'discord-subject-paged',
    });

    const subjectId = await t.run(async (ctx) => {
      const subjectId = await ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-subject-paged',
        authUserId: 'creator-auth-subject-paged',
        displayName: 'Wrongly Owned Buyer Paged',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      for (let index = 0; index < 60; index += 1) {
        const createdAt = now + index + 1;
        await ctx.db.insert('subjects', {
          primaryDiscordUserId: `discord-subject-filler-${index}`,
          displayName: `Subject Filler ${index}`,
          status: 'active',
          createdAt,
          updatedAt: createdAt,
        });
      }

      return subjectId;
    });

    const report = await t.query(internal.migrations.listSubjectOwnershipRemediationCandidates, {
      limit: 1,
    });

    expect(report.summary.candidateSubjects).toBe(1);
    expect(report.candidates).toEqual([
      expect.objectContaining({
        subjectId,
        currentAuthUserId: 'creator-auth-subject-paged',
        expectedAuthUserId: 'buyer-auth-subject-paged',
      }),
    ]);
  });

  it('repairs subject ownership and removes the foreign links from the old auth user page', async () => {
    const t = makeTestConvex() as ComponentAwareTestConvex;
    const now = Date.now();

    await seedBetterAuthDiscordAccount(t, {
      authUserMarker: 'buyer-auth-subject-repair',
      email: 'buyer-subject-repair@example.com',
      name: 'Buyer Subject Repair',
      discordUserId: 'discord-subject-repair',
    });

    const subjectId = await t.run(async (ctx) => {
      return await ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-subject-repair',
        authUserId: 'creator-auth-subject-repair',
        displayName: 'Wrongly Owned Repair Buyer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });

    await t.run(async (ctx) => {
      const discordExternalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'discord',
        providerUserId: 'discord-subject-repair',
        providerUsername: 'repair-buyer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('buyer_provider_links', {
        subjectId,
        provider: 'discord',
        externalAccountId: discordExternalAccountId,
        verificationMethod: 'account_link',
        status: 'active',
        linkedAt: now,
        lastValidatedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('bindings', {
        authUserId: 'creator-auth-subject-repair',
        subjectId,
        externalAccountId: discordExternalAccountId,
        bindingType: 'verification',
        status: 'active',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    });

    const beforeOldOwnerLinks = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: 'test-secret',
      authUserId: 'creator-auth-subject-repair',
    });
    expect(beforeOldOwnerLinks).toHaveLength(1);

    const result = await t.mutation(internal.migrations.repairSubjectOwnershipCandidates, {
      subjectIds: [subjectId],
    });

    expect(result).toMatchObject({
      repairedSubjects: 1,
      createdLightAuthUsers: 0,
      repairedBindings: 1,
      skippedSubjects: [],
      skippedBindings: [],
    });

    const afterOldOwnerLinks = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: 'test-secret',
      authUserId: 'creator-auth-subject-repair',
    });
    const afterBuyerLinks = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: 'test-secret',
      authUserId: 'buyer-auth-subject-repair',
    });

    expect(afterOldOwnerLinks).toHaveLength(0);
    expect(afterBuyerLinks).toHaveLength(1);

    const repairedSubject = await t.run(async (ctx) => ctx.db.get(subjectId));
    expect(repairedSubject?.authUserId).toBe('buyer-auth-subject-repair');
  });

  it('materializes a light auth owner when the Discord user has no Better Auth account', async () => {
    const t = makeTestConvex() as ComponentAwareTestConvex;
    const now = Date.now();

    const subjectId = await t.run(async (ctx) => {
      return await ctx.db.insert('subjects', {
        primaryDiscordUserId: 'discord-subject-light',
        authUserId: 'creator-auth-subject-light',
        displayName: 'Light Subject Buyer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });

    await t.run(async (ctx) => {
      const externalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'gumroad',
        providerUserId: 'subject-light-gumroad-user',
        providerUsername: 'SubjectLightBuyer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('buyer_provider_links', {
        subjectId,
        provider: 'gumroad',
        externalAccountId,
        verificationMethod: 'account_link',
        status: 'active',
        linkedAt: now,
        lastValidatedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });

    const report = await t.query(internal.migrations.listSubjectOwnershipRemediationCandidates, {
      limit: 10,
    });

    expect(report.candidates).toEqual([
      expect.objectContaining({
        subjectId,
        currentAuthUserId: 'creator-auth-subject-light',
        expectedLightAuthMarker: 'light-discord:discord-subject-light',
        resolution: 'new_light',
        repairable: true,
      }),
    ]);

    const result = await t.mutation(internal.migrations.repairSubjectOwnershipCandidates, {
      subjectIds: [subjectId],
    });

    expect(result).toMatchObject({
      repairedSubjects: 1,
      createdLightAuthUsers: 1,
      skippedSubjects: [],
    });

    const repairedSubject = await t.run(async (ctx) => ctx.db.get(subjectId));
    expect(repairedSubject?.authUserId).toBeTruthy();
    expect(repairedSubject?.authUserId).not.toBe('creator-auth-subject-light');

    const newOwnerLinks = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: 'test-secret',
      authUserId: repairedSubject?.authUserId ?? '',
    });
    expect(newOwnerLinks).toHaveLength(1);
  });

  it('marks provider-scoped subjects with conflicting active auth bindings as ambiguous instead of auto-repairing them', async () => {
    const t = makeTestConvex() as ComponentAwareTestConvex;
    const now = Date.now();

    const subjectId = await t.run(async (ctx) => {
      return await ctx.db.insert('subjects', {
        primaryDiscordUserId: 'itchio:itch-buyer-42',
        authUserId: 'buyer-auth-intruder',
        displayName: 'Provider Scoped Buyer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });

    await t.run(async (ctx) => {
      const externalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'itchio',
        providerUserId: 'itch-buyer-42',
        providerUsername: 'itch-owner',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('buyer_provider_links', {
        subjectId,
        provider: 'itchio',
        externalAccountId,
        verificationMethod: 'account_link',
        status: 'active',
        linkedAt: now,
        lastValidatedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('bindings', {
        authUserId: 'buyer-auth-owner',
        subjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('bindings', {
        authUserId: 'buyer-auth-intruder',
        subjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        version: 1,
        createdAt: now + 1,
        updatedAt: now + 1,
      });
    });

    const report = await t.query(internal.migrations.listSubjectOwnershipRemediationCandidates, {
      limit: 10,
    });

    expect(report.candidates).toEqual([
      expect.objectContaining({
        subjectId,
        currentAuthUserId: 'buyer-auth-intruder',
        discordUserId: 'itchio:itch-buyer-42',
        ambiguousAuthUserIds: ['buyer-auth-intruder', 'buyer-auth-owner'],
        resolution: 'ambiguous',
        repairable: false,
      }),
    ]);

    const result = await t.mutation(internal.migrations.repairSubjectOwnershipCandidates, {
      subjectIds: [subjectId],
    });

    expect(result).toMatchObject({
      repairedSubjects: 0,
      createdLightAuthUsers: 0,
      skippedSubjects: [
        {
          subjectId,
          reason: 'Subject ownership is ambiguous and requires manual review',
        },
      ],
    });
  });
});

describe('role sync redrive migration', () => {
  it('selectively redrives transient Discord rate-limit failures', async () => {
    const original = process.env.ROLE_SYNC_VIA_WORKPOOL;
    process.env.ROLE_SYNC_VIA_WORKPOOL = 'true';
    const enqueueSpy = vi.spyOn(roleSyncPool, 'enqueueAction').mockResolvedValue(TEST_WORK_ID);
    try {
      const t = makeTestConvex();
      const now = Date.now();
      const { rateLimitedJobId, permanentJobId } = await t.run(async (ctx) => {
        const subjectId = await ctx.db.insert('subjects', {
          primaryDiscordUserId: 'discord-selective-rate-limit-redrive',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
        const entitlementId = await ctx.db.insert('entitlements', {
          authUserId: 'auth-selective-rate-limit-redrive',
          subjectId,
          productId: 'product-selective-rate-limit-redrive',
          sourceProvider: 'gumroad',
          sourceReference: 'order-selective-rate-limit-redrive',
          status: 'active',
          grantedAt: now,
          updatedAt: now,
        });
        const baseJob = {
          authUserId: 'auth-selective-rate-limit-redrive',
          jobType: 'role_sync' as const,
          payload: {
            subjectId,
            entitlementId,
            discordUserId: 'discord-selective-rate-limit-redrive',
          },
          status: 'dead_letter' as const,
          targetDiscordUserId: 'discord-selective-rate-limit-redrive',
          retryCount: 10,
          maxRetries: 10,
          createdAt: now,
          updatedAt: now,
        };
        const rateLimitedJobId = await ctx.db.insert('outbox_jobs', {
          ...baseJob,
          idempotencyKey: 'selective-rate-limit-redrive-transient',
          lastError: 'Uncaught Error: Rate limited (retry after 4s)',
        });
        const permanentJobId = await ctx.db.insert('outbox_jobs', {
          ...baseJob,
          idempotencyKey: 'selective-rate-limit-redrive-permanent',
          lastError: 'Discord API error 10007: Unknown Member',
          createdAt: now + 1,
          updatedAt: now + 1,
        });
        return { rateLimitedJobId, permanentJobId };
      });

      const result = await t.mutation(internal.migrations.redriveRateLimitedRoleSync, {
        scanLimit: 10,
      });
      const stored = await t.run(async (ctx) => ({
        rateLimited: await ctx.db.get(rateLimitedJobId),
        permanent: await ctx.db.get(permanentJobId),
      }));

      expect(result).toMatchObject({
        scanned: 2,
        matched: 1,
        processed: 1,
        skipped: 0,
        isDone: true,
      });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(stored.rateLimited?.status).toBe('pending');
      expect(stored.rateLimited?.lastError).toBeUndefined();
      expect(stored.permanent?.status).toBe('dead_letter');
      expect(stored.permanent?.lastError).toContain('Unknown Member');
    } finally {
      enqueueSpy.mockRestore();
      if (original === undefined) delete process.env.ROLE_SYNC_VIA_WORKPOOL;
      else process.env.ROLE_SYNC_VIA_WORKPOOL = original;
    }
  });

  it('redrives role-removal jobs without entitlement ids through Workpool', async () => {
    const original = process.env.ROLE_SYNC_VIA_WORKPOOL;
    process.env.ROLE_SYNC_VIA_WORKPOOL = 'true';
    const enqueueSpy = vi.spyOn(roleSyncPool, 'enqueueAction').mockResolvedValue(TEST_WORK_ID);
    try {
      const t = makeTestConvex();
      const now = Date.now();
      const jobId = await t.run(async (ctx) => {
        const subjectId = await ctx.db.insert('subjects', {
          primaryDiscordUserId: 'discord-redrive-missing-entitlement',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
        return ctx.db.insert('outbox_jobs', {
          authUserId: 'auth-redrive-missing-entitlement',
          jobType: 'role_removal',
          payload: {
            subjectId,
            guildId: 'guild-redrive-missing-entitlement',
            roleId: 'role-redrive-missing-entitlement',
            discordUserId: 'discord-redrive-missing-entitlement',
          },
          status: 'dead_letter',
          idempotencyKey: 'redrive-missing-entitlement',
          targetGuildId: 'guild-redrive-missing-entitlement',
          targetDiscordUserId: 'discord-redrive-missing-entitlement',
          retryCount: 5,
          maxRetries: 5,
          lastError: 'legacy worker failed',
          createdAt: now,
          updatedAt: now,
        });
      });

      const result = await t.mutation(internal.migrations.redriveDeadLetterRoleSync, { limit: 1 });
      const stored = await t.run(async (ctx) => ctx.db.get(jobId));

      expect(result).toEqual({ processed: 1, skipped: 0, remaining: 0 });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(stored?.status).toBe('pending');
      expect(stored?.lastError).toBeUndefined();
    } finally {
      enqueueSpy.mockRestore();
      if (original === undefined) delete process.env.ROLE_SYNC_VIA_WORKPOOL;
      else process.env.ROLE_SYNC_VIA_WORKPOOL = original;
    }
  });

  it('pages past non-role dead letters when redriving role jobs', async () => {
    const original = process.env.ROLE_SYNC_VIA_WORKPOOL;
    process.env.ROLE_SYNC_VIA_WORKPOOL = 'true';
    const enqueueSpy = vi.spyOn(roleSyncPool, 'enqueueAction').mockResolvedValue(TEST_WORK_ID);
    try {
      const t = makeTestConvex();
      const now = Date.now();
      const roleJobId = await t.run(async (ctx) => {
        for (let index = 0; index < 1000; index++) {
          await ctx.db.insert('outbox_jobs', {
            authUserId: 'auth-redrive-non-role-window',
            jobType: 'creator_alert',
            payload: { index },
            status: 'dead_letter',
            idempotencyKey: `redrive-non-role-window-${index}`,
            retryCount: 5,
            maxRetries: 5,
            lastError: 'non-role failure',
            createdAt: now + index,
            updatedAt: now + index,
          });
        }
        const subjectId = await ctx.db.insert('subjects', {
          primaryDiscordUserId: 'discord-redrive-window',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
        const entitlementId = await ctx.db.insert('entitlements', {
          authUserId: 'auth-redrive-window',
          subjectId,
          productId: 'product-redrive-window',
          sourceProvider: 'gumroad',
          sourceReference: 'order-redrive-window',
          status: 'active',
          grantedAt: now,
          updatedAt: now,
        });
        return ctx.db.insert('outbox_jobs', {
          authUserId: 'auth-redrive-window',
          jobType: 'role_sync',
          payload: {
            subjectId,
            entitlementId,
            discordUserId: 'discord-redrive-window',
          },
          status: 'dead_letter',
          idempotencyKey: 'redrive-window-role-sync',
          targetDiscordUserId: 'discord-redrive-window',
          retryCount: 5,
          maxRetries: 5,
          lastError: 'legacy worker failed',
          createdAt: now + 1001,
          updatedAt: now + 1001,
        });
      });

      const result = await t.mutation(internal.migrations.redriveDeadLetterRoleSync, { limit: 1 });
      const stored = await t.run(async (ctx) => ctx.db.get(roleJobId));

      expect(result).toEqual({ processed: 1, skipped: 0, remaining: 0 });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(stored?.status).toBe('pending');
    } finally {
      enqueueSpy.mockRestore();
      if (original === undefined) delete process.env.ROLE_SYNC_VIA_WORKPOOL;
      else process.env.ROLE_SYNC_VIA_WORKPOOL = original;
    }
  });

  it('preserves original creation time when Workpool accepts redrive work', async () => {
    const original = process.env.ROLE_SYNC_VIA_WORKPOOL;
    process.env.ROLE_SYNC_VIA_WORKPOOL = 'true';
    const enqueueSpy = vi.spyOn(roleSyncPool, 'enqueueAction').mockResolvedValue(TEST_WORK_ID);
    try {
      const t = makeTestConvex();
      const now = Date.now();
      const originalCreatedAt = now - 10_000;
      const originalUpdatedAt = now - 5_000;
      const jobId = await t.run(async (ctx) => {
        const subjectId = await ctx.db.insert('subjects', {
          primaryDiscordUserId: 'discord-redrive-preserve-created',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
        const entitlementId = await ctx.db.insert('entitlements', {
          authUserId: 'auth-redrive-preserve-created',
          subjectId,
          productId: 'product-redrive-preserve-created',
          sourceProvider: 'gumroad',
          sourceReference: 'order-redrive-preserve-created',
          status: 'active',
          grantedAt: now,
          updatedAt: now,
        });
        return ctx.db.insert('outbox_jobs', {
          authUserId: 'auth-redrive-preserve-created',
          jobType: 'role_sync',
          payload: {
            subjectId,
            entitlementId,
            discordUserId: 'discord-redrive-preserve-created',
          },
          status: 'dead_letter',
          idempotencyKey: 'redrive-preserve-created',
          targetDiscordUserId: 'discord-redrive-preserve-created',
          retryCount: 5,
          maxRetries: 5,
          lastError: 'legacy worker failed',
          createdAt: originalCreatedAt,
          updatedAt: originalUpdatedAt,
        });
      });

      const result = await t.mutation(internal.migrations.redriveDeadLetterRoleSync, { limit: 1 });
      const stored = await t.run(async (ctx) => ctx.db.get(jobId));

      expect(result).toEqual({ processed: 1, skipped: 0, remaining: 0 });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(stored?.status).toBe('pending');
      expect(stored?.createdAt).toBe(originalCreatedAt);
      expect(stored?.updatedAt).toBeGreaterThanOrEqual(now);
    } finally {
      enqueueSpy.mockRestore();
      if (original === undefined) delete process.env.ROLE_SYNC_VIA_WORKPOOL;
      else process.env.ROLE_SYNC_VIA_WORKPOOL = original;
    }
  });

  it('reports only the bounded page remainder when role redrive backlog exceeds the limit', async () => {
    const original = process.env.ROLE_SYNC_VIA_WORKPOOL;
    process.env.ROLE_SYNC_VIA_WORKPOOL = 'true';
    const enqueueSpy = vi.spyOn(roleSyncPool, 'enqueueAction').mockResolvedValue(TEST_WORK_ID);
    try {
      const t = makeTestConvex();
      const now = Date.now();
      const jobIds = await t.run(async (ctx) => {
        const subjectId = await ctx.db.insert('subjects', {
          primaryDiscordUserId: 'discord-redrive-bounded-page',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
        const entitlementId = await ctx.db.insert('entitlements', {
          authUserId: 'auth-redrive-bounded-page',
          subjectId,
          productId: 'product-redrive-bounded-page',
          sourceProvider: 'gumroad',
          sourceReference: 'order-redrive-bounded-page',
          status: 'active',
          grantedAt: now,
          updatedAt: now,
        });
        const inserted = [];
        for (let index = 0; index < 3; index++) {
          inserted.push(
            await ctx.db.insert('outbox_jobs', {
              authUserId: 'auth-redrive-bounded-page',
              jobType: 'role_sync',
              payload: {
                subjectId,
                entitlementId,
                discordUserId: `discord-redrive-bounded-page-${index}`,
              },
              status: 'dead_letter',
              idempotencyKey: `redrive-bounded-page-${index}`,
              targetDiscordUserId: `discord-redrive-bounded-page-${index}`,
              retryCount: 5,
              maxRetries: 5,
              lastError: 'legacy worker failed',
              createdAt: now + index,
              updatedAt: now + index,
            })
          );
        }
        return inserted;
      });

      const result = await t.mutation(internal.migrations.redriveDeadLetterRoleSync, { limit: 1 });
      const storedRows = await t.run(async (ctx) =>
        Promise.all(jobIds.map(async (jobId) => ctx.db.get(jobId)))
      );

      expect(result).toEqual({ processed: 1, skipped: 0, remaining: 1 });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(storedRows.map((row) => row?.status)).toEqual([
        'pending',
        'dead_letter',
        'dead_letter',
      ]);
    } finally {
      enqueueSpy.mockRestore();
      if (original === undefined) delete process.env.ROLE_SYNC_VIA_WORKPOOL;
      else process.env.ROLE_SYNC_VIA_WORKPOOL = original;
    }
  });

  it('leaves dead-letter rows untouched when Workpool redrive enqueue fails', async () => {
    const original = process.env.ROLE_SYNC_VIA_WORKPOOL;
    process.env.ROLE_SYNC_VIA_WORKPOOL = 'true';
    const enqueueSpy = vi
      .spyOn(roleSyncPool, 'enqueueAction')
      .mockRejectedValue(new Error('workpool unavailable'));
    try {
      const t = makeTestConvex();
      const now = Date.now();
      const originalCreatedAt = now - 10_000;
      const originalUpdatedAt = now - 5_000;
      const jobId = await t.run(async (ctx) => {
        const subjectId = await ctx.db.insert('subjects', {
          primaryDiscordUserId: 'discord-redrive-enqueue-fails',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
        const entitlementId = await ctx.db.insert('entitlements', {
          authUserId: 'auth-redrive-enqueue-fails',
          subjectId,
          productId: 'product-redrive-enqueue-fails',
          sourceProvider: 'gumroad',
          sourceReference: 'order-redrive-enqueue-fails',
          status: 'active',
          grantedAt: now,
          updatedAt: now,
        });
        return ctx.db.insert('outbox_jobs', {
          authUserId: 'auth-redrive-enqueue-fails',
          jobType: 'role_sync',
          payload: {
            subjectId,
            entitlementId,
            discordUserId: 'discord-redrive-enqueue-fails',
          },
          status: 'dead_letter',
          idempotencyKey: 'redrive-enqueue-fails',
          targetDiscordUserId: 'discord-redrive-enqueue-fails',
          retryCount: 5,
          maxRetries: 5,
          lastError: 'legacy worker failed',
          createdAt: originalCreatedAt,
          updatedAt: originalUpdatedAt,
        });
      });

      await expect(
        t.mutation(internal.migrations.redriveDeadLetterRoleSync, { limit: 1 })
      ).rejects.toThrow('workpool unavailable');
      const stored = await t.run(async (ctx) => ctx.db.get(jobId));

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(stored?.status).toBe('dead_letter');
      expect(stored?.retryCount).toBe(5);
      expect(stored?.lastError).toBe('legacy worker failed');
      expect(stored?.createdAt).toBe(originalCreatedAt);
      expect(stored?.updatedAt).toBe(originalUpdatedAt);
    } finally {
      enqueueSpy.mockRestore();
      if (original === undefined) delete process.env.ROLE_SYNC_VIA_WORKPOOL;
      else process.env.ROLE_SYNC_VIA_WORKPOOL = original;
    }
  });

  it('requires the Workpool rollout flag before redriving dead-lettered role jobs', async () => {
    const original = process.env.ROLE_SYNC_VIA_WORKPOOL;
    delete process.env.ROLE_SYNC_VIA_WORKPOOL;
    try {
      const t = makeTestConvex();
      await expect(
        t.mutation(internal.migrations.redriveDeadLetterRoleSync, { limit: 1 })
      ).rejects.toThrow(/ROLE_SYNC_VIA_WORKPOOL/);
    } finally {
      if (original === undefined) delete process.env.ROLE_SYNC_VIA_WORKPOOL;
      else process.env.ROLE_SYNC_VIA_WORKPOOL = original;
    }
  });
});

describe('creator VPM link catalog field migration', () => {
  it('creates the explicit package binding before removing the retired catalog field', async () => {
    const legacyCreatorVpmLinks = defineTable(
      schema.tables.creator_vpm_links.validator.extend({
        catalogProductId: v.optional(v.id('product_catalog')),
      })
    )
      .index('by_link_id', ['linkId'])
      .index('by_creator_package_status', ['creatorAuthUserId', 'packageId', 'status']);
    const legacySchema = defineSchema({
      ...schema.tables,
      creator_vpm_links: legacyCreatorVpmLinks,
    });
    const t = convexTest(legacySchema, (import.meta as TestImportMeta).glob('./**/*.ts'));
    const now = Date.now();
    const linkId = 'stable-link-id-for-migration';
    const rowId = await t.run(async (ctx) => {
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: 'creator-vpm-link-migration',
        productId: 'product-vpm-link-migration',
        provider: 'manual',
        providerProductRef: 'manual-product-vpm-link-migration',
        displayName: 'VPM link migration product',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId: 'com.yucp.migration-product',
        packageName: 'VPM link migration product',
        publisherId: 'creator:creator-vpm-link-migration',
        yucpUserId: 'creator-vpm-link-migration',
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });
      return ctx.db.insert('creator_vpm_links', {
        creatorAuthUserId: 'creator-vpm-link-migration',
        packageId: 'com.yucp.migration-product',
        catalogProductId,
        linkId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      } as never);
    });

    const result = await t.mutation(internal.migrations.purgeCreatorVpmLinkCatalogProductIds, {
      limit: 100,
    });
    const stored = await t.run(async (ctx) => ctx.db.get(rowId));
    const binding = await t.run(async (ctx) =>
      ctx.db
        .query('package_catalog_bindings')
        .withIndex('by_creator_package_status', (q) =>
          q
            .eq('creatorAuthUserId', 'creator-vpm-link-migration')
            .eq('packageId', 'com.yucp.migration-product')
            .eq('status', 'active')
        )
        .unique()
    );

    expect(result).toEqual({
      continueCursor: expect.any(String),
      isDone: true,
      scanned: 1,
      unresolved: 0,
      updated: 1,
    });
    expect(stored?.linkId).toBe(linkId);
    expect('catalogProductId' in (stored as unknown as Record<string, unknown>)).toBe(false);
    expect(binding).toMatchObject({
      catalogProductId: expect.any(String),
      creatorAuthUserId: 'creator-vpm-link-migration',
      packageId: 'com.yucp.migration-product',
      status: 'active',
    });
  });

  it('reports an unresolved retired field instead of presenting a clean migration pass', async () => {
    const legacyCreatorVpmLinks = defineTable(
      schema.tables.creator_vpm_links.validator.extend({
        catalogProductId: v.optional(v.id('product_catalog')),
      })
    )
      .index('by_link_id', ['linkId'])
      .index('by_creator_package_status', ['creatorAuthUserId', 'packageId', 'status']);
    const legacySchema = defineSchema({
      ...schema.tables,
      creator_vpm_links: legacyCreatorVpmLinks,
    });
    const t = convexTest(legacySchema, (import.meta as TestImportMeta).glob('./**/*.ts'));
    const now = Date.now();
    await t.run(async (ctx) => {
      const foreignProductId = await ctx.db.insert('product_catalog', {
        authUserId: 'different-creator',
        productId: 'foreign-vpm-link-product',
        provider: 'manual',
        providerProductRef: 'foreign-vpm-link-product',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId: 'com.yucp.unresolved-vpm-link',
        publisherId: 'creator:creator-unresolved-vpm-link',
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: 'creator-unresolved-vpm-link',
      });
      await ctx.db.insert('creator_vpm_links', {
        catalogProductId: foreignProductId,
        createdAt: now,
        creatorAuthUserId: 'creator-unresolved-vpm-link',
        linkId: 'L'.repeat(43),
        packageId: 'com.yucp.unresolved-vpm-link',
        status: 'active',
        updatedAt: now,
      } as never);
    });

    const result = await t.mutation(internal.migrations.purgeCreatorVpmLinkCatalogProductIds, {
      limit: 100,
    });

    expect(result).toMatchObject({
      isDone: true,
      scanned: 1,
      unresolved: 1,
      updated: 0,
    });
  });

  it('uses an explicit cursor to bound retired-field migration writes', async () => {
    const legacyCreatorVpmLinks = defineTable(
      schema.tables.creator_vpm_links.validator.extend({
        catalogProductId: v.optional(v.id('product_catalog')),
      })
    )
      .index('by_link_id', ['linkId'])
      .index('by_creator_package_status', ['creatorAuthUserId', 'packageId', 'status']);
    const legacySchema = defineSchema({
      ...schema.tables,
      creator_vpm_links: legacyCreatorVpmLinks,
    });
    const t = convexTest(legacySchema, (import.meta as TestImportMeta).glob('./**/*.ts'));
    const now = Date.now();
    await t.run(async (ctx) => {
      const creatorAuthUserId = 'creator-bounded-vpm-link-migration';
      const packageId = 'com.yucp.bounded-vpm-link-migration';
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: 'bounded-vpm-link-product',
        provider: 'manual',
        providerProductRef: 'bounded-vpm-link-product',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${creatorAuthUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: creatorAuthUserId,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId,
        createdAt: now,
        creatorAuthUserId,
        packageId,
        status: 'active',
        updatedAt: now,
      });
      for (let index = 0; index < 8; index++) {
        await ctx.db.insert('creator_vpm_links', {
          catalogProductId,
          createdAt: now + index,
          creatorAuthUserId,
          linkId: `${index}`.repeat(43),
          packageId,
          status: 'active',
          updatedAt: now + index,
        } as never);
      }
    });

    const first = await t.mutation(internal.migrations.purgeCreatorVpmLinkCatalogProductIds, {
      limit: 500,
    });
    const second = await t.mutation(internal.migrations.purgeCreatorVpmLinkCatalogProductIds, {
      cursor: first.continueCursor,
      limit: 500,
    });

    expect(first).toMatchObject({
      isDone: false,
      scanned: 5,
      unresolved: 0,
      updated: 5,
    });
    expect(second).toMatchObject({
      isDone: true,
      scanned: 3,
      unresolved: 0,
      updated: 3,
    });
  });

  it('repairs an already-purged link from one active creator-owned release pointer', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const creatorAuthUserId = 'creator-vpm-link-repair';
    const packageId = 'com.yucp.repair-product';
    const linkId = 'R'.repeat(43);
    await t.run(async (ctx) => {
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: 'product-vpm-link-repair',
        provider: 'manual',
        providerProductRef: 'manual-product-vpm-link-repair',
        displayName: 'VPM link repair product',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId,
        packageName: 'VPM link repair product',
        publisherId: `creator:${creatorAuthUserId}`,
        yucpUserId: creatorAuthUserId,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_versions_ref', {
        packageId,
        version: '1.0.0',
        versionId: crypto.randomUUID(),
        activeContentDigest: '11'.repeat(32),
        activePolicyVersion: 'active-content-policy-v1',
        bindingRoot: '22'.repeat(32),
        commonRoot: '33'.repeat(32),
        logicalBytes: 1,
        logicalFiles: 1,
        manifestSha256: '44'.repeat(32),
        protectedFiles: [],
        protectedSourceRoot: '55'.repeat(32),
        protectionPolicyDigest: '66'.repeat(32),
        protectionPolicyId: 'protected-file-classification-v1',
        releaseRoot: '77'.repeat(32),
        vpmDependencies: {},
        vpmRepositories: {},
        channel: 'stable',
        state: 'READY',
        catalogProductId,
        createdAt: now,
      });
      await ctx.db.insert('creator_vpm_links', {
        creatorAuthUserId,
        packageId,
        linkId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });

    const first = await t.mutation(internal.migrations.repairCreatorVpmLinkPackageBindings, {
      limit: 100,
    });
    const second = await t.mutation(internal.migrations.repairCreatorVpmLinkPackageBindings, {
      limit: 100,
    });
    const storedLink = await t.run(async (ctx) =>
      ctx.db
        .query('creator_vpm_links')
        .withIndex('by_link_id', (q) => q.eq('linkId', linkId))
        .unique()
    );
    const bindings = await t.run(async (ctx) =>
      ctx.db
        .query('package_catalog_bindings')
        .withIndex('by_creator_package_status', (q) =>
          q.eq('creatorAuthUserId', creatorAuthUserId).eq('packageId', packageId)
        )
        .collect()
    );

    expect(first).toMatchObject({ isDone: true, repaired: 1, unresolved: 0 });
    expect(second).toMatchObject({ isDone: true, repaired: 0, unresolved: 0 });
    expect(storedLink?.linkId).toBe(linkId);
    expect(storedLink?.status).toBe('active');
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      creatorAuthUserId,
      packageId,
      status: 'active',
    });
  });

  it('fails closed when an already-purged link has ambiguous release pointers', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const creatorAuthUserId = 'creator-vpm-link-ambiguous';
    const packageId = 'com.yucp.ambiguous-product';
    await t.run(async (ctx) => {
      await ctx.db.insert('package_registry', {
        packageId,
        packageName: 'Ambiguous VPM link product',
        publisherId: `creator:${creatorAuthUserId}`,
        yucpUserId: creatorAuthUserId,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });
      for (const index of [1, 2]) {
        const catalogProductId = await ctx.db.insert('product_catalog', {
          authUserId: creatorAuthUserId,
          productId: `product-vpm-link-ambiguous-${index}`,
          provider: 'manual',
          providerProductRef: `manual-product-vpm-link-ambiguous-${index}`,
          displayName: `Ambiguous VPM link product ${index}`,
          status: 'active',
          supportsAutoDiscovery: false,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert('package_versions_ref', {
          packageId,
          version: `1.0.${index}`,
          versionId: crypto.randomUUID(),
          activeContentDigest: `${index}1`.repeat(32),
          activePolicyVersion: 'active-content-policy-v1',
          bindingRoot: `${index}2`.repeat(32),
          commonRoot: `${index}3`.repeat(32),
          logicalBytes: 1,
          logicalFiles: 1,
          manifestSha256: `${index}4`.repeat(32),
          protectedFiles: [],
          protectedSourceRoot: `${index}5`.repeat(32),
          protectionPolicyDigest: `${index}6`.repeat(32),
          protectionPolicyId: 'protected-file-classification-v1',
          releaseRoot: `${index}7`.repeat(32),
          vpmDependencies: {},
          vpmRepositories: {},
          channel: 'stable',
          state: index === 1 ? 'SUPERSEDED' : 'READY',
          catalogProductId,
          createdAt: now + index,
        });
      }
      await ctx.db.insert('creator_vpm_links', {
        creatorAuthUserId,
        packageId,
        linkId: 'U'.repeat(43),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.mutation(internal.migrations.repairCreatorVpmLinkPackageBindings, {
      limit: 100,
    });
    const bindings = await t.run(async (ctx) =>
      ctx.db
        .query('package_catalog_bindings')
        .withIndex('by_creator_package_status', (q) =>
          q.eq('creatorAuthUserId', creatorAuthUserId).eq('packageId', packageId)
        )
        .collect()
    );

    expect(result).toMatchObject({ isDone: true, repaired: 0, unresolved: 1 });
    expect(bindings).toEqual([]);
  });

  it('fails closed when link repair needs an unbounded package-version scan', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const creatorAuthUserId = 'creator-vpm-link-bounded-repair';
    const packageId = 'com.yucp.vpm-link-bounded-repair';
    await t.run(async (ctx) => {
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: 'vpm-link-bounded-repair',
        provider: 'manual',
        providerProductRef: 'vpm-link-bounded-repair',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${creatorAuthUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: creatorAuthUserId,
      });
      for (let index = 0; index < 65; index++) {
        await ctx.db.insert('package_versions_ref', {
          activeContentDigest: '11'.repeat(32),
          activePolicyVersion: 'active-content-policy-v1',
          bindingRoot: '22'.repeat(32),
          catalogProductId,
          channel: 'stable',
          commonRoot: '33'.repeat(32),
          createdAt: now + index,
          editionId: 'standard',
          logicalBytes: 1,
          logicalFiles: 1,
          manifestSha256: '44'.repeat(32),
          packageId,
          protectedFiles: [],
          protectedSourceRoot: '55'.repeat(32),
          protectionPolicyDigest: '66'.repeat(32),
          protectionPolicyId: 'protected-file-classification-v1',
          releaseRoot: `${index.toString(16).padStart(2, '0')}`.repeat(32),
          state: index === 64 ? 'READY' : 'SUPERSEDED',
          version: `1.0.${index}`,
          versionId: crypto.randomUUID(),
          vpmDependencies: {},
          vpmRepositories: {},
        });
      }
      await ctx.db.insert('creator_vpm_links', {
        createdAt: now,
        creatorAuthUserId,
        linkId: 'Q'.repeat(43),
        packageId,
        status: 'active',
        updatedAt: now,
      });
    });

    const result = await t.mutation(internal.migrations.repairCreatorVpmLinkPackageBindings, {
      limit: 100,
    });
    const bindings = await t.run(async (ctx) =>
      ctx.db
        .query('package_catalog_bindings')
        .withIndex('by_creator_package_status', (q) =>
          q.eq('creatorAuthUserId', creatorAuthUserId).eq('packageId', packageId)
        )
        .collect()
    );

    expect(result).toMatchObject({ isDone: true, repaired: 0, unresolved: 1 });
    expect(bindings).toEqual([]);
  });
});

describe('package version release publication migration', () => {
  it('backfills the complete authoritative release publication before removing legacy fields', async () => {
    const t = makeTestConvex();
    const versionId = crypto.randomUUID();
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert('package_versions_ref', {
        channel: 'stable',
        contentType: 'application/zip',
        createdAt: Date.now(),
        packageId: 'com.yucp.legacy-release',
        state: 'READY',
        totalSize: 1024,
        version: '1.0.0',
        versionId,
      } as never)
    );

    const before = await t.query(internal.migrations.listPackageVersionReleaseBackfillCandidates, {
      limit: 5,
    });
    const result = await t.mutation(internal.migrations.backfillPackageVersionReleasePublication, {
      activeContentDigest: '11'.repeat(32),
      activePolicyVersion: 'active-content-policy-v1',
      bindingRoot: '22'.repeat(32),
      commonRoot: '33'.repeat(32),
      logicalBytes: 1024,
      logicalFiles: 1,
      manifestSha256: '44'.repeat(32),
      protectedFiles: [],
      protectedSourceRoot: '55'.repeat(32),
      protectionPolicyDigest: '66'.repeat(32),
      protectionPolicyId: 'protected-file-classification-v1',
      releaseRoot: '77'.repeat(32),
      versionId,
      vpmDependencies: {},
      vpmRepositories: {},
    });
    const stored = await t.run(async (ctx) => ctx.db.get(rowId));
    const after = await t.query(internal.migrations.listPackageVersionReleaseBackfillCandidates, {
      limit: 5,
    });

    expect(before).toMatchObject({
      candidates: [{ packageId: 'com.yucp.legacy-release', version: '1.0.0', versionId }],
      isDone: true,
      scanned: 1,
    });
    expect(result).toEqual({ status: 'updated' });
    expect(stored).toMatchObject({
      activeContentDigest: '11'.repeat(32),
      logicalBytes: 1024,
      releaseRoot: '77'.repeat(32),
      vpmDependencies: {},
      vpmRepositories: {},
    });
    expect(stored).not.toHaveProperty('contentType');
    expect(stored).not.toHaveProperty('totalSize');
    expect(after).toMatchObject({ candidates: [], isDone: true, scanned: 1 });
  });
});

describe('package version edition identity migration', () => {
  it('clamps requested batches to five package-scoped rows', async () => {
    const t = makeTestConvex();
    const packageId = 'com.yucp.edition-batch-bound';
    await t.run(async (ctx) => {
      for (let index = 0; index < 8; index++) {
        await ctx.db.insert('package_versions_ref', {
          packageId,
          version: `1.0.${index}`,
          versionId: crypto.randomUUID(),
          editionId: 'standard',
          activeContentDigest: '11'.repeat(32),
          activePolicyVersion: 'active-content-policy-v1',
          bindingRoot: '22'.repeat(32),
          commonRoot: '33'.repeat(32),
          logicalBytes: 1,
          logicalFiles: 1,
          manifestSha256: '44'.repeat(32),
          protectedFiles: [],
          protectedSourceRoot: '55'.repeat(32),
          protectionPolicyDigest: '66'.repeat(32),
          protectionPolicyId: 'protected-file-classification-v1',
          releaseRoot: '77'.repeat(32),
          vpmDependencies: {},
          vpmRepositories: {},
          channel: 'stable',
          state: 'SUPERSEDED',
          createdAt: index,
        });
      }
    });

    const result = await t.mutation(internal.migrations.repairPackageVersionEditionIds, {
      limit: 500,
      packageId,
    });

    expect(result).toMatchObject({
      isDone: false,
      repaired: 0,
      scanned: 5,
      unresolved: 0,
    });
  });

  it('repairs one unambiguous active edition without changing the version identity', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const creatorAuthUserId = 'creator-edition-repair';
    const packageId = 'com.yucp.edition-repair';
    const versionId = crypto.randomUUID();
    const versionRowId = await t.run(async (ctx) => {
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: 'edition-repair-product',
        provider: 'manual',
        providerProductRef: 'edition-repair-product',
        displayName: 'Edition repair product',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId,
        packageName: 'Edition repair product',
        publisherId: `creator:${creatorAuthUserId}`,
        yucpUserId: creatorAuthUserId,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_editions', {
        catalogProductIds: [catalogProductId],
        catalogTierIds: [],
        createdAt: now,
        creatorAuthUserId,
        displayName: 'Commercial',
        editionId: 'commercial',
        packageId,
        priority: 0,
        status: 'active',
        updatedAt: now,
      });
      return await ctx.db.insert('package_versions_ref', {
        packageId,
        version: '1.0.0',
        versionId,
        editionId: 'standard',
        activeContentDigest: '11'.repeat(32),
        activePolicyVersion: 'active-content-policy-v1',
        bindingRoot: '22'.repeat(32),
        commonRoot: '33'.repeat(32),
        logicalBytes: 1,
        logicalFiles: 1,
        manifestSha256: '44'.repeat(32),
        protectedFiles: [],
        protectedSourceRoot: '55'.repeat(32),
        protectionPolicyDigest: '66'.repeat(32),
        protectionPolicyId: 'protected-file-classification-v1',
        releaseRoot: '77'.repeat(32),
        vpmDependencies: {},
        vpmRepositories: {},
        channel: 'stable',
        state: 'READY',
        catalogProductId,
        createdAt: now,
      });
    });
    await t.run(async (ctx) => {
      for (let index = 0; index < 256; index++) {
        await ctx.db.insert('package_versions_ref', {
          packageId: `com.yucp.unrelated-${index}`,
          version: '1.0.0',
          versionId: crypto.randomUUID(),
          editionId: 'standard',
          activeContentDigest: '11'.repeat(32),
          activePolicyVersion: 'active-content-policy-v1',
          bindingRoot: '22'.repeat(32),
          commonRoot: '33'.repeat(32),
          logicalBytes: 1,
          logicalFiles: 1,
          manifestSha256: '44'.repeat(32),
          protectedFiles: [],
          protectedSourceRoot: '55'.repeat(32),
          protectionPolicyDigest: '66'.repeat(32),
          protectionPolicyId: 'protected-file-classification-v1',
          releaseRoot: '77'.repeat(32),
          vpmDependencies: {},
          vpmRepositories: {},
          channel: 'stable',
          state: 'READY',
          createdAt: now,
        });
      }
    });

    const first = await t.mutation(internal.migrations.repairPackageVersionEditionIds, {
      limit: 100,
      packageId,
    });
    const second = await t.mutation(internal.migrations.repairPackageVersionEditionIds, {
      limit: 100,
      packageId,
    });
    const stored = await t.run(async (ctx) => ctx.db.get(versionRowId));

    expect(first).toMatchObject({ isDone: true, repaired: 1, scanned: 1, unresolved: 0 });
    expect(second).toMatchObject({ isDone: true, repaired: 0, scanned: 1, unresolved: 0 });
    expect(stored).toMatchObject({
      editionId: 'commercial',
      releaseRoot: '77'.repeat(32),
      state: 'READY',
      versionId,
    });
  });

  it('fails closed when two active editions contain the release catalog product', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const creatorAuthUserId = 'creator-edition-ambiguous';
    const packageId = 'com.yucp.edition-ambiguous';
    const versionRowId = await t.run(async (ctx) => {
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: 'edition-ambiguous-product',
        provider: 'manual',
        providerProductRef: 'edition-ambiguous-product',
        displayName: 'Edition ambiguous product',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId,
        packageName: 'Edition ambiguous product',
        publisherId: `creator:${creatorAuthUserId}`,
        yucpUserId: creatorAuthUserId,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });
      for (const [priority, editionId] of ['personal', 'commercial'].entries()) {
        await ctx.db.insert('package_editions', {
          catalogProductIds: [catalogProductId],
          catalogTierIds: [],
          createdAt: now,
          creatorAuthUserId,
          displayName: editionId,
          editionId,
          packageId,
          priority,
          status: 'active',
          updatedAt: now,
        });
      }
      return await ctx.db.insert('package_versions_ref', {
        packageId,
        version: '1.0.0',
        versionId: crypto.randomUUID(),
        editionId: 'standard',
        activeContentDigest: '11'.repeat(32),
        activePolicyVersion: 'active-content-policy-v1',
        bindingRoot: '22'.repeat(32),
        commonRoot: '33'.repeat(32),
        logicalBytes: 1,
        logicalFiles: 1,
        manifestSha256: '44'.repeat(32),
        protectedFiles: [],
        protectedSourceRoot: '55'.repeat(32),
        protectionPolicyDigest: '66'.repeat(32),
        protectionPolicyId: 'protected-file-classification-v1',
        releaseRoot: '77'.repeat(32),
        vpmDependencies: {},
        vpmRepositories: {},
        channel: 'stable',
        state: 'READY',
        catalogProductId,
        createdAt: now,
      });
    });

    const result = await t.mutation(internal.migrations.repairPackageVersionEditionIds, {
      limit: 100,
      packageId,
    });
    const stored = await t.run(async (ctx) => ctx.db.get(versionRowId));

    expect(result).toMatchObject({ isDone: true, repaired: 0, unresolved: 1 });
    expect(stored?.editionId).toBe('standard');
  });

  it('keeps an edition migration unresolved when the current edition is one ambiguous match', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const creatorAuthUserId = 'creator-edition-current-ambiguous';
    const packageId = 'com.yucp.edition-current-ambiguous';
    const rowId = await t.run(async (ctx) => {
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: 'edition-current-ambiguous',
        provider: 'manual',
        providerProductRef: 'edition-current-ambiguous',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${creatorAuthUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: creatorAuthUserId,
      });
      for (const [priority, editionId] of ['standard', 'commercial'].entries()) {
        await ctx.db.insert('package_editions', {
          catalogProductIds: [catalogProductId],
          catalogTierIds: [],
          createdAt: now,
          creatorAuthUserId,
          displayName: editionId,
          editionId,
          packageId,
          priority,
          status: 'active',
          updatedAt: now,
        });
      }
      return await ctx.db.insert('package_versions_ref', {
        activeContentDigest: '11'.repeat(32),
        activePolicyVersion: 'active-content-policy-v1',
        bindingRoot: '22'.repeat(32),
        catalogProductId,
        channel: 'stable',
        commonRoot: '33'.repeat(32),
        createdAt: now,
        editionId: 'standard',
        logicalBytes: 1,
        logicalFiles: 1,
        manifestSha256: '44'.repeat(32),
        packageId,
        protectedFiles: [],
        protectedSourceRoot: '55'.repeat(32),
        protectionPolicyDigest: '66'.repeat(32),
        protectionPolicyId: 'protected-file-classification-v1',
        releaseRoot: '77'.repeat(32),
        state: 'READY',
        version: '1.0.0',
        versionId: crypto.randomUUID(),
        vpmDependencies: {},
        vpmRepositories: {},
      });
    });

    const result = await t.mutation(internal.migrations.repairPackageVersionEditionIds, {
      limit: 100,
      packageId,
    });
    const stored = await t.run(async (ctx) => ctx.db.get(rowId));

    expect(result).toMatchObject({ isDone: true, repaired: 0, unresolved: 1 });
    expect(stored?.editionId).toBe('standard');
  });

  it('fails closed when edition ownership exceeds the bounded migration scan', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const creatorAuthUserId = 'creator-edition-bounded-scan';
    const packageId = 'com.yucp.edition-bounded-scan';
    const rowId = await t.run(async (ctx) => {
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: creatorAuthUserId,
        productId: 'edition-bounded-scan',
        provider: 'manual',
        providerProductRef: 'edition-bounded-scan',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: `creator:${creatorAuthUserId}`,
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: creatorAuthUserId,
      });
      for (let index = 0; index < 65; index++) {
        await ctx.db.insert('package_editions', {
          catalogProductIds: index === 0 ? [catalogProductId] : [],
          catalogTierIds: [],
          createdAt: now,
          creatorAuthUserId,
          displayName: `Edition ${index}`,
          editionId: index === 0 ? 'standard' : `other-${index}`,
          packageId,
          priority: index,
          status: 'active',
          updatedAt: now,
        });
      }
      return await ctx.db.insert('package_versions_ref', {
        activeContentDigest: '11'.repeat(32),
        activePolicyVersion: 'active-content-policy-v1',
        bindingRoot: '22'.repeat(32),
        catalogProductId,
        channel: 'stable',
        commonRoot: '33'.repeat(32),
        createdAt: now,
        editionId: 'legacy',
        logicalBytes: 1,
        logicalFiles: 1,
        manifestSha256: '44'.repeat(32),
        packageId,
        protectedFiles: [],
        protectedSourceRoot: '55'.repeat(32),
        protectionPolicyDigest: '66'.repeat(32),
        protectionPolicyId: 'protected-file-classification-v1',
        releaseRoot: '77'.repeat(32),
        state: 'READY',
        version: '1.0.0',
        versionId: crypto.randomUUID(),
        vpmDependencies: {},
        vpmRepositories: {},
      });
    });

    const result = await t.mutation(internal.migrations.repairPackageVersionEditionIds, {
      limit: 100,
      packageId,
    });
    const stored = await t.run(async (ctx) => ctx.db.get(rowId));

    expect(result).toMatchObject({ isDone: true, repaired: 0, unresolved: 1 });
    expect(stored?.editionId).toBe('legacy');
  });
});
describe('catalog product canonical URL repair', () => {
  async function seedCatalogProduct(
    t: ReturnType<typeof makeTestConvex>,
    input: {
      authUserId: string;
      provider: 'gumroad' | 'jinxxy' | 'lemonsqueezy' | 'vrchat';
      providerProductRef: string;
      canonicalSlug?: string;
      link?: { originalUrl: string; urlHash?: string };
    }
  ) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: input.authUserId,
        productId: `product-${input.providerProductRef}`,
        provider: input.provider,
        providerProductRef: input.providerProductRef,
        ...(input.canonicalSlug ? { canonicalSlug: input.canonicalSlug } : {}),
        displayName: 'Seed Product',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
      if (input.link) {
        const normalized = input.link.originalUrl.toLowerCase().trim();
        await ctx.db.insert('catalog_product_links', {
          catalogProductId,
          provider: input.provider,
          originalUrl: input.link.originalUrl,
          normalizedUrl: normalized,
          urlHash: input.link.urlHash ?? `hash-${normalized}`,
          linkKind: 'direct_product',
          status: 'active',
          submittedByAuthUserId: input.authUserId,
          createdAt: now,
          updatedAt: now,
        });
      }
      return catalogProductId;
    });
  }

  async function getLinks(t: ReturnType<typeof makeTestConvex>, catalogProductId: unknown) {
    return await t.run(async (ctx) =>
      ctx.db
        .query('catalog_product_links')
        .withIndex('by_catalog_product', (q) =>
          q.eq('catalogProductId', catalogProductId as never)
        )
        .collect()
    );
  }

  it('repairs a junk Gumroad template link using the stored canonical slug', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'creator-repair-gumroad',
      provider: 'gumroad',
      providerProductRef: 'Dcmv6A==',
      canonicalSlug: 'Fluffgan',
      link: { originalUrl: 'https://gumroad.com/l/Dcmv6A==' },
    });

    const result = await t.mutation(internal.migrations.repairCatalogProductCanonicalUrls, {
      apply: true,
      limit: 100,
    });

    const links = await getLinks(t, catalogProductId);
    expect(result).toMatchObject({ isDone: true, repaired: 1 });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      originalUrl: 'https://gumroad.com/l/Fluffgan',
      normalizedUrl: 'https://gumroad.com/l/fluffgan',
      status: 'active',
    });
  });

  it('inserts a missing direct product link when the URL is slug-derivable', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'creator-repair-missing',
      provider: 'gumroad',
      providerProductRef: 'Dcmv6A==',
      canonicalSlug: 'fluffgan',
    });

    const result = await t.mutation(internal.migrations.repairCatalogProductCanonicalUrls, {
      apply: true,
      limit: 100,
    });

    const links = await getLinks(t, catalogProductId);
    expect(result).toMatchObject({ isDone: true, inserted: 1 });
    expect(links).toHaveLength(1);
    expect(links[0]?.originalUrl).toBe('https://gumroad.com/l/fluffgan');
  });

  it('removes known junk links that have no derivable replacement', async () => {
    const t = makeTestConvex();
    const jinxxyId = await seedCatalogProduct(t, {
      authUserId: 'creator-repair-junk-1',
      provider: 'jinxxy',
      providerProductRef: 'jinxxy-uuid-1',
      link: { originalUrl: 'https://jinxxy.app/products/jinxxy-uuid-1' },
    });
    const lemonId = await seedCatalogProduct(t, {
      authUserId: 'creator-repair-junk-2',
      provider: 'lemonsqueezy',
      providerProductRef: '123456',
      link: { originalUrl: 'https://app.lemonsqueezy.com/products/123456' },
    });
    const vrchatId = await seedCatalogProduct(t, {
      authUserId: 'creator-repair-junk-3',
      provider: 'vrchat',
      providerProductRef: 'prod_00000000-0000-0000-0000-000000000000',
      link: {
        originalUrl:
          'https://vrchat.com/store/listing/prod_00000000-0000-0000-0000-000000000000',
      },
    });
    const invalidId = await seedCatalogProduct(t, {
      authUserId: 'creator-repair-junk-4',
      provider: 'jinxxy',
      providerProductRef: 'jinxxy-uuid-2',
      link: { originalUrl: 'https://example.invalid/jinxxy/jinxxy-uuid-2' },
    });

    const result = await t.mutation(internal.migrations.repairCatalogProductCanonicalUrls, {
      apply: true,
      limit: 100,
    });

    expect(result).toMatchObject({ isDone: true, junkRemoved: 4, needsResync: 3 });
    expect(await getLinks(t, jinxxyId)).toHaveLength(0);
    expect(await getLinks(t, lemonId)).toHaveLength(0);
    expect(await getLinks(t, vrchatId)).toHaveLength(0);
    expect(await getLinks(t, invalidId)).toHaveLength(0);
    expect(result.needsResyncProducts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'jinxxy', providerProductRef: 'jinxxy-uuid-1' }),
        expect.objectContaining({ provider: 'lemonsqueezy', providerProductRef: '123456' }),
      ])
    );
    expect(result.needsResyncProducts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'vrchat',
          providerProductRef: 'prod_00000000-0000-0000-0000-000000000000',
        }),
      ])
    );
  });

  it('leaves already-correct links untouched', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'creator-repair-clean',
      provider: 'gumroad',
      providerProductRef: 'Dcmv6A==',
      canonicalSlug: 'fluffgan',
      link: { originalUrl: 'https://quaggycharr.gumroad.com/l/fluffgan' },
    });

    const result = await t.mutation(internal.migrations.repairCatalogProductCanonicalUrls, {
      apply: true,
      limit: 100,
    });

    const links = await getLinks(t, catalogProductId);
    expect(result).toMatchObject({ isDone: true, repaired: 0, inserted: 0, junkRemoved: 0 });
    expect(links).toHaveLength(1);
    expect(links[0]?.originalUrl).toBe('https://quaggycharr.gumroad.com/l/fluffgan');
  });

  it('reports without writing when apply is false', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'creator-repair-dry-run',
      provider: 'gumroad',
      providerProductRef: 'Dcmv6A==',
      canonicalSlug: 'fluffgan',
      link: { originalUrl: 'https://gumroad.com/l/Dcmv6A==' },
    });

    const result = await t.mutation(internal.migrations.repairCatalogProductCanonicalUrls, {
      apply: false,
      limit: 100,
    });

    const links = await getLinks(t, catalogProductId);
    expect(result).toMatchObject({ isDone: true, repaired: 1 });
    expect(links[0]?.originalUrl).toBe('https://gumroad.com/l/Dcmv6A==');
  });
});
