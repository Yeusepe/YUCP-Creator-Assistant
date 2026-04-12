import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex, seedCreatorProfile, seedSubject } from './testHelpers';

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
});
