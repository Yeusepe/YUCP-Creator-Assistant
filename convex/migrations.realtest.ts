import type { WorkId } from '@convex-dev/workpool';
import type { GenericActionCtx, GenericMutationCtx } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { DataModel } from './_generated/dataModel';
import betterAuthSchema from './betterAuth/schema';
import { roleSyncPool } from './roleSyncWorkpool';
import { makeTestConvex } from './testHelpers';

type ComponentMutationCtx = GenericMutationCtx<DataModel> &
  Pick<GenericActionCtx<DataModel>, 'storage'>;

const TEST_WORK_ID = 'test-role-sync-work' as WorkId;

type ComponentAwareTestConvex = ReturnType<typeof makeTestConvex> & {
  runInComponent: <Output>(
    componentPath: string,
    handler: (ctx: ComponentMutationCtx) => Promise<Output>
  ) => Promise<Output>;
  registerComponent: (
    componentPath: string,
    schema: unknown,
    functions: Record<string, () => Promise<unknown>>
  ) => void;
};

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
    const licenseRefTierIds = await t.query(api.catalogTiers.getActiveCatalogTierIdsForEntitlement, {
      apiSecret: 'test-secret',
      entitlementId: licenseRefEntitlementId,
    });

    expect(licenseRefTierIds).toEqual([catalogTierId]);
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
        .filter((q) =>
          q.eq(q.field('authUserId'), 'creator-remediate-shared-order-tier-evidence')
        )
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
    t.registerComponent('betterAuth', betterAuthSchema, import.meta.glob('./betterAuth/**/*.ts'));
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
    t.registerComponent('betterAuth', betterAuthSchema, import.meta.glob('./betterAuth/**/*.ts'));
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
    t.registerComponent('betterAuth', betterAuthSchema, import.meta.glob('./betterAuth/**/*.ts'));
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
    t.registerComponent('betterAuth', betterAuthSchema, import.meta.glob('./betterAuth/**/*.ts'));
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
    t.registerComponent('betterAuth', betterAuthSchema, import.meta.glob('./betterAuth/**/*.ts'));
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
