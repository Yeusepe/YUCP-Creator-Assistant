import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex, seedCreatorProfile, seedEntitlement, seedSubject } from './testHelpers';

const API_SECRET = 'test-secret';

describe('license verification account linking', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
  });

  it('creates a buyer provider link so manual-license verification surfaces as a connected account', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-license-verification-link';
    const subjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-license-verification-link',
    });

    await seedCreatorProfile(t, {
      authUserId,
      ownerDiscordUserId: 'discord-license-verification-link',
    });

    const result = await t.mutation(api.licenseVerification.completeLicenseVerification, {
      apiSecret: API_SECRET,
      authUserId,
      subjectId,
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-123',
      providerUsername: 'LinkedBuyer',
      productsToGrant: [
        {
          productId: 'product-license-verification-link',
          sourceReference: 'order-license-verification-link',
        },
      ],
    });

    expect(result.success).toBe(true);

    const links = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId,
    });

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-123',
      providerUsername: 'LinkedBuyer',
      status: 'active',
    });
  });

  it('writes typed entitlement evidence with provider tier refs for verified licenses', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-license-verification-tier-evidence';
    const subjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-license-verification-tier-evidence',
    });

    await seedCreatorProfile(t, {
      authUserId,
      ownerDiscordUserId: 'discord-license-verification-tier-evidence',
    });

    const result = await t.mutation(api.licenseVerification.completeLicenseVerification, {
      apiSecret: API_SECRET,
      authUserId,
      subjectId,
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-tier-evidence',
      productsToGrant: [
        {
          productId: 'product-license-verification-tier-evidence',
          sourceReference: 'jinxxy:order-tier-evidence:license-tier-evidence',
          providerTierRefs: ['version-advanced'],
        },
      ],
    } as never);

    expect(result.success).toBe(true);

    const evidence = await t.run((ctx) =>
      ctx.db
        .query('entitlement_evidence')
        .withIndex('by_source_reference', (q) =>
          q
            .eq('providerKey', 'jinxxy')
            .eq('sourceReference', 'jinxxy:order-tier-evidence:license-tier-evidence')
        )
        .filter((q) => q.eq(q.field('authUserId'), authUserId))
        .first()
    );

    expect(evidence).toMatchObject({
      authUserId,
      subjectId,
      providerKey: 'jinxxy',
      evidenceType: 'license_verification',
      status: 'active',
      productId: 'product-license-verification-tier-evidence',
      providerTierRefs: ['version-advanced'],
    });
  });

  it('reuses and migrates legacy raw-order entitlements when canonical license source refs are verified', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-license-verification-legacy-ref-creator';
    const buyerAuthUserId = 'auth-license-verification-legacy-ref-buyer';
    const buyerSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-license-verification-legacy-ref-buyer',
    });

    const creatorProfileId = await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-license-verification-legacy-ref-creator',
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(creatorProfileId, {
        policy: { duplicateVerificationBehavior: 'block' },
        updatedAt: Date.now(),
      });
    });

    const legacyEntitlementId = await seedEntitlement(t, buyerSubjectId, {
      authUserId: creatorAuthUserId,
      productId: 'product-license-verification-legacy-ref',
      sourceProvider: 'jinxxy',
      sourceReference: 'order-license-verification-legacy-ref',
      status: 'active',
    });

    const result = await t.mutation(api.licenseVerification.completeLicenseVerification, {
      apiSecret: API_SECRET,
      creatorAuthUserId,
      buyerAuthUserId,
      subjectId: buyerSubjectId,
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-legacy-ref',
      productsToGrant: [
        {
          productId: 'product-license-verification-legacy-ref',
          sourceReference: 'jinxxy:order-license-verification-legacy-ref:license-legacy-ref',
          providerTierRefs: ['version-legacy-ref'],
        },
      ],
      licenseSubjectLink: {
        licenseSubject: 'legacy-ref-license-subject',
        licenseKeyEncrypted: 'encrypted-legacy-ref-license-key',
        providerProductId: 'product-license-verification-legacy-ref',
      },
    } as never);

    expect(result.success).toBe(true);
    expect(result.entitlementIds).toEqual([legacyEntitlementId]);
    expect(result.outboxJobIds).toHaveLength(1);

    const { entitlements, evidence } = await t.run(async (ctx) => {
      const entitlements = await ctx.db
        .query('entitlements')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', creatorAuthUserId).eq('subjectId', buyerSubjectId)
        )
        .collect();
      const evidence = await ctx.db
        .query('entitlement_evidence')
        .withIndex('by_source_reference', (q) =>
          q
            .eq('providerKey', 'jinxxy')
            .eq('sourceReference', 'jinxxy:order-license-verification-legacy-ref:license-legacy-ref')
        )
        .filter((q) => q.eq(q.field('authUserId'), creatorAuthUserId))
        .first();
      return { entitlements, evidence };
    });

    expect(entitlements).toHaveLength(1);
    expect(entitlements[0]).toMatchObject({
      _id: legacyEntitlementId,
      sourceReference: 'jinxxy:order-license-verification-legacy-ref:license-legacy-ref',
      licenseSubject: 'legacy-ref-license-subject',
      status: 'active',
    });
    expect(evidence).toMatchObject({
      providerTierRefs: ['version-legacy-ref'],
      status: 'active',
      productId: 'product-license-verification-legacy-ref',
    });
  });

  it('reuses order-only canonical entitlements when canonical license source refs are verified', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-license-verification-order-ref-creator';
    const buyerAuthUserId = 'auth-license-verification-order-ref-buyer';
    const buyerSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-license-verification-order-ref-buyer',
    });

    const creatorProfileId = await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-license-verification-order-ref-creator',
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(creatorProfileId, {
        policy: { duplicateVerificationBehavior: 'block' },
        updatedAt: Date.now(),
      });
    });

    const existingEntitlementId = await seedEntitlement(t, buyerSubjectId, {
      authUserId: creatorAuthUserId,
      productId: 'product-license-verification-order-ref',
      sourceProvider: 'jinxxy',
      sourceReference: 'jinxxy:order-license-verification-order-ref',
      status: 'active',
    });

    const result = await t.mutation(api.licenseVerification.completeLicenseVerification, {
      apiSecret: API_SECRET,
      creatorAuthUserId,
      buyerAuthUserId,
      subjectId: buyerSubjectId,
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-order-ref',
      productsToGrant: [
        {
          productId: 'product-license-verification-order-ref',
          sourceReference: 'jinxxy:order-license-verification-order-ref:license-order-ref',
          providerTierRefs: ['version-order-ref'],
        },
      ],
    } as never);

    expect(result.success).toBe(true);
    expect(result.entitlementIds).toEqual([existingEntitlementId]);

    const entitlements = await t.run(async (ctx) =>
      ctx.db
        .query('entitlements')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', creatorAuthUserId).eq('subjectId', buyerSubjectId)
        )
        .collect()
    );

    expect(entitlements).toHaveLength(1);
    expect(entitlements[0]).toMatchObject({
      _id: existingEntitlementId,
      sourceProvider: 'jinxxy',
      sourceReference: 'jinxxy:order-license-verification-order-ref:license-order-ref',
      productId: 'product-license-verification-order-ref',
      status: 'active',
    });
  });

  it('does not reuse another provider entitlement when raw order ids collide', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-license-verification-provider-collision-creator';
    const buyerAuthUserId = 'auth-license-verification-provider-collision-buyer';
    const buyerSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-license-verification-provider-collision-buyer',
    });

    await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-license-verification-provider-collision-creator',
    });

    const otherProviderEntitlementId = await seedEntitlement(t, buyerSubjectId, {
      authUserId: creatorAuthUserId,
      productId: 'product-license-verification-provider-collision',
      sourceProvider: 'gumroad',
      sourceReference: 'order-license-verification-provider-collision',
      status: 'active',
    });

    const result = await t.mutation(api.licenseVerification.completeLicenseVerification, {
      apiSecret: API_SECRET,
      creatorAuthUserId,
      buyerAuthUserId,
      subjectId: buyerSubjectId,
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-provider-collision',
      productsToGrant: [
        {
          productId: 'product-license-verification-provider-collision',
          sourceReference:
            'jinxxy:order-license-verification-provider-collision:license-provider-collision',
          providerTierRefs: ['version-provider-collision'],
        },
      ],
    } as never);

    expect(result.success).toBe(true);
    expect(result.entitlementIds).not.toEqual([otherProviderEntitlementId]);

    const entitlements = await t.run(async (ctx) =>
      ctx.db
        .query('entitlements')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', creatorAuthUserId).eq('subjectId', buyerSubjectId)
        )
        .collect()
    );

    expect(entitlements).toHaveLength(2);
    expect(entitlements.find((entitlement) => entitlement._id === otherProviderEntitlementId))
      .toMatchObject({
        sourceProvider: 'gumroad',
        sourceReference: 'order-license-verification-provider-collision',
      });
    expect(entitlements.find((entitlement) => entitlement.sourceProvider === 'jinxxy'))
      .toMatchObject({
        productId: 'product-license-verification-provider-collision',
        sourceReference:
          'jinxxy:order-license-verification-provider-collision:license-provider-collision',
      });
  });

  it('keeps manual-license buyer links symmetric across account reads, disconnect, and reconcile', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-license-verification-account-symmetry';
    const subjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-license-verification-account-symmetry',
    });

    await seedCreatorProfile(t, {
      authUserId,
      ownerDiscordUserId: 'discord-license-verification-account-symmetry',
    });

    const result = await t.mutation(api.licenseVerification.completeLicenseVerification, {
      apiSecret: API_SECRET,
      authUserId,
      subjectId,
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-account-symmetry',
      providerUsername: 'SymmetryBuyer',
      productsToGrant: [
        {
          productId: 'product-license-verification-account-symmetry',
          sourceReference: 'order-license-verification-account-symmetry',
        },
      ],
    });

    expect(result.success).toBe(true);

    const linksAfterWrite = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId,
    });

    expect(linksAfterWrite).toHaveLength(1);
    const [linkAfterWrite] = linksAfterWrite;
    if (!linkAfterWrite) {
      throw new Error('Expected the buyer provider link to exist after verification');
    }
    expect(linkAfterWrite).toMatchObject({
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-account-symmetry',
      providerUsername: 'SymmetryBuyer',
      verificationMethod: 'account_link',
      status: 'active',
    });

    const revokeResult = await t.mutation(api.subjects.revokeBuyerProviderLink, {
      apiSecret: API_SECRET,
      authUserId,
      linkId: linkAfterWrite.id,
    });

    expect(revokeResult).toEqual({ success: true });

    const linksAfterDisconnect = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId,
    });
    expect(linksAfterDisconnect).toEqual([]);

    const reconcileResult = await t.mutation(api.subjects.reconcileBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId,
    });

    expect(reconcileResult.reconciledCount).toBe(0);

    const linksAfterReconcile = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId,
    });
    expect(linksAfterReconcile).toEqual([]);
  });

  it('records a license subject link for verified licenses so leak tracing can resolve the buyer later', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-license-verification-forensics';
    const subjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-license-verification-forensics',
    });

    await seedCreatorProfile(t, {
      authUserId,
      ownerDiscordUserId: 'discord-license-verification-forensics',
    });

    const result = await t.mutation(api.licenseVerification.completeLicenseVerification, {
      apiSecret: API_SECRET,
      authUserId,
      subjectId,
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-forensics',
      providerUsername: 'ForensicsBuyer',
      productsToGrant: [
        {
          productId: 'product-license-verification-forensics',
          sourceReference: 'order-license-verification-forensics',
        },
      ],
      licenseSubjectLink: {
        licenseSubject: '3dea218ee2aca2785da88513407c1a78cecc034f6cd2c25d98251a2fbb5717df',
        licenseKeyEncrypted: 'encrypted-license-key',
        providerProductId: 'product-license-verification-forensics',
      },
    });

    expect(result.success).toBe(true);

    const identity = await t.run((ctx) =>
      ctx.db
        .query('license_subject_links')
        .withIndex('by_auth_user_subject', (q) =>
          q
            .eq('authUserId', authUserId)
            .eq(
              'licenseSubject',
              '3dea218ee2aca2785da88513407c1a78cecc034f6cd2c25d98251a2fbb5717df'
            )
        )
        .first()
    );

    expect(identity).toMatchObject({
      authUserId,
      provider: 'jinxxy',
      licenseKeyEncrypted: 'encrypted-license-key',
      providerProductId: 'product-license-verification-forensics',
    });
  });

  it('attributes manual-license verification to the buyer when the creator owns the product', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-license-verification-creator';
    const buyerAuthUserId = 'auth-license-verification-buyer';
    const buyerSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-license-verification-buyer',
    });

    await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-license-verification-creator',
    });

    const result = await t.mutation(api.licenseVerification.completeLicenseVerification, {
      apiSecret: API_SECRET,
      creatorAuthUserId,
      buyerAuthUserId,
      subjectId: buyerSubjectId,
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-buyer-owned',
      providerUsername: 'BuyerOwned',
      productsToGrant: [
        {
          productId: 'product-license-verification-cross-user',
          sourceReference: 'order-license-verification-cross-user',
        },
      ],
      licenseSubjectLink: {
        licenseSubject: 'cross-user-license-subject',
        licenseKeyEncrypted: 'encrypted-cross-user-license-key',
        providerProductId: 'product-license-verification-cross-user',
      },
    } as never);

    expect(result.success).toBe(true);

    const buyerLinks = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId: buyerAuthUserId,
    });
    const creatorLinks = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId: creatorAuthUserId,
    });

    expect(buyerLinks).toHaveLength(1);
    expect(buyerLinks[0]).toMatchObject({
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-buyer-owned',
      providerUsername: 'BuyerOwned',
      status: 'active',
    });
    expect(creatorLinks).toHaveLength(0);

    const buyerIdentity = await t.run((ctx) =>
      ctx.db
        .query('license_subject_links')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', buyerAuthUserId).eq('licenseSubject', 'cross-user-license-subject')
        )
        .first()
    );
    const creatorIdentity = await t.run((ctx) =>
      ctx.db
        .query('license_subject_links')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', creatorAuthUserId).eq('licenseSubject', 'cross-user-license-subject')
        )
        .first()
    );

    expect(buyerIdentity).toMatchObject({
      authUserId: buyerAuthUserId,
      provider: 'jinxxy',
      providerProductId: 'product-license-verification-cross-user',
    });
    expect(creatorIdentity).toBeNull();
  });

  it('grants each product separately when provider licenses share an order source reference', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-license-verification-shared-order-creator';
    const buyerAuthUserId = 'auth-license-verification-shared-order-buyer';
    const buyerSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-license-verification-shared-order-buyer',
    });

    await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-license-verification-shared-order-creator',
    });

    const firstResult = await t.mutation(api.licenseVerification.completeLicenseVerification, {
      apiSecret: API_SECRET,
      creatorAuthUserId,
      buyerAuthUserId,
      subjectId: buyerSubjectId,
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-shared-order',
      productsToGrant: [
        {
          productId: 'product-license-verification-shared-order-a',
          sourceReference: 'jinxxy-order-shared-by-multiple-licenses',
        },
      ],
    } as never);

    const secondResult = await t.mutation(api.licenseVerification.completeLicenseVerification, {
      apiSecret: API_SECRET,
      creatorAuthUserId,
      buyerAuthUserId,
      subjectId: buyerSubjectId,
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-shared-order',
      productsToGrant: [
        {
          productId: 'product-license-verification-shared-order-b',
          sourceReference: 'jinxxy-order-shared-by-multiple-licenses',
        },
      ],
    } as never);

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
    expect(firstResult.outboxJobIds).toHaveLength(1);
    expect(secondResult.outboxJobIds).toHaveLength(1);
    expect(secondResult.entitlementIds).not.toEqual(firstResult.entitlementIds);

    const entitlements = await t.run((ctx) =>
      ctx.db
        .query('entitlements')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', creatorAuthUserId).eq('subjectId', buyerSubjectId)
        )
        .collect()
    );

    expect(entitlements.map((e) => e.productId).sort()).toEqual([
      'product-license-verification-shared-order-a',
      'product-license-verification-shared-order-b',
    ]);

    const evidenceRows = await t.run((ctx) =>
      ctx.db
        .query('entitlement_evidence')
        .withIndex('by_source_reference', (q) =>
          q.eq('providerKey', 'jinxxy').eq('sourceReference', 'jinxxy-order-shared-by-multiple-licenses')
        )
        .filter((q) => q.eq(q.field('authUserId'), creatorAuthUserId))
        .collect()
    );

    expect(evidenceRows.map((evidence) => evidence.productId).sort()).toEqual([
      'product-license-verification-shared-order-a',
      'product-license-verification-shared-order-b',
    ]);
  });

  it('skips Discord role sync for provider-prefixed subject ids on new and reactivated grants', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-license-verification-provider-subject-creator';
    const buyerAuthUserId = 'auth-license-verification-provider-subject-buyer';
    const buyerSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'gumroad:provider-subject-id',
    });

    await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-license-verification-provider-subject-creator',
    });

    const grantArgs = {
      apiSecret: API_SECRET,
      creatorAuthUserId,
      buyerAuthUserId,
      subjectId: buyerSubjectId,
      provider: 'gumroad',
      providerUserId: 'gumroad-provider-subject-user',
      providerUsername: 'ProviderSubjectBuyer',
      productsToGrant: [
        {
          productId: 'product-license-verification-provider-subject',
          sourceReference: 'order-license-verification-provider-subject',
        },
      ],
    } as const;

    const firstResult = await t.mutation(api.licenseVerification.completeLicenseVerification, {
      ...grantArgs,
    } as never);

    expect(firstResult.success).toBe(true);
    expect(firstResult.entitlementIds).toHaveLength(1);
    expect(firstResult.outboxJobIds).toEqual([]);

    const [entitlementId] = firstResult.entitlementIds;
    if (!entitlementId) {
      throw new Error('Expected entitlement to be created');
    }
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(entitlementId, {
        status: 'revoked',
        revokedAt: now,
        updatedAt: now,
      });
    });

    const secondResult = await t.mutation(api.licenseVerification.completeLicenseVerification, {
      ...grantArgs,
    } as never);

    expect(secondResult.success).toBe(true);
    expect(secondResult.entitlementIds).toEqual(firstResult.entitlementIds);
    expect(secondResult.outboxJobIds).toEqual([]);
  });

  it('rejects explicit buyer attribution when the subject belongs to a different auth user', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'auth-license-verification-creator-mismatch';
    const buyerSubjectId = await seedSubject(t, {
      authUserId: 'buyer-auth-from-subject',
      primaryDiscordUserId: 'discord-license-verification-buyer-mismatch',
    });

    await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-license-verification-creator-mismatch',
    });

    await expect(
      t.mutation(api.licenseVerification.completeLicenseVerification, {
        apiSecret: API_SECRET,
        creatorAuthUserId,
        buyerAuthUserId: 'buyer-auth-from-request',
        subjectId: buyerSubjectId,
        provider: 'jinxxy',
        providerUserId: 'jinxxy-user-mismatch',
        providerUsername: 'MismatchBuyer',
        productsToGrant: [
          {
            productId: 'product-license-verification-mismatch',
            sourceReference: 'order-license-verification-mismatch',
          },
        ],
      } as never)
    ).rejects.toThrow(
      `Subject ${buyerSubjectId} does not belong to buyer auth user buyer-auth-from-request`
    );
  });

  it('reconciles legacy verification bindings into buyer provider links', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-license-verification-reconcile';
    const subjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-license-verification-reconcile',
    });

    await t.run(async (ctx) => {
      const now = Date.now();
      const externalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'jinxxy',
        providerUserId: 'jinxxy-user-legacy',
        providerUsername: 'LegacyBuyer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('bindings', {
        authUserId,
        subjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: subjectId,
        reason: 'Legacy manual license verification',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    });

    const reconcileResult = await t.mutation(api.subjects.reconcileBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId,
    });

    expect(reconcileResult.reconciledCount).toBe(1);

    const links = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId,
    });

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-legacy',
      providerUsername: 'LegacyBuyer',
      verificationMethod: 'account_link',
      status: 'active',
    });
  });

  it('restores a revoked buyer provider link after the buyer reconnects and reconcile reruns', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-license-verification-reconnect-after-revoke';
    const subjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-license-verification-reconnect-after-revoke',
    });

    const externalAccountId = await t.run(async (ctx) => {
      const now = Date.now();
      const accountId = await ctx.db.insert('external_accounts', {
        provider: 'jinxxy',
        providerUserId: 'jinxxy-user-reconnect-after-revoke',
        providerUsername: 'ReconnectBuyer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('bindings', {
        authUserId,
        subjectId,
        externalAccountId: accountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: subjectId,
        reason: 'Initial buyer verification',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      return accountId;
    });

    await expect(
      t.mutation(api.subjects.reconcileBuyerProviderLinksForAuthUser, {
        apiSecret: API_SECRET,
        authUserId,
      })
    ).resolves.toEqual({ reconciledCount: 1 });

    const [initialLink] = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId,
    });
    if (!initialLink) {
      throw new Error('Expected the initial buyer provider link to exist');
    }
    expect(initialLink).toMatchObject({
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-reconnect-after-revoke',
      status: 'active',
    });

    await expect(
      t.mutation(api.subjects.revokeBuyerProviderLink, {
        apiSecret: API_SECRET,
        authUserId,
        linkId: initialLink.id,
      })
    ).resolves.toEqual({ success: true });
    await expect(
      t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
        apiSecret: API_SECRET,
        authUserId,
      })
    ).resolves.toEqual([]);

    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('bindings', {
        authUserId,
        subjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: subjectId,
        reason: 'Buyer reconnected after revoke',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(
      t.mutation(api.subjects.reconcileBuyerProviderLinksForAuthUser, {
        apiSecret: API_SECRET,
        authUserId,
      })
    ).resolves.toEqual({ reconciledCount: 1 });

    await expect(
      t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
        apiSecret: API_SECRET,
        authUserId,
      })
    ).resolves.toMatchObject([
      expect.objectContaining({
        id: initialLink.id,
        provider: 'jinxxy',
        providerUserId: 'jinxxy-user-reconnect-after-revoke',
        status: 'active',
      }),
    ]);
  });
});
