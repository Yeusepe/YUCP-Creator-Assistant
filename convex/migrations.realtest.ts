import { beforeEach, describe, expect, it } from 'vitest';
import type { GenericActionCtx, GenericMutationCtx } from 'convex/server';
import { api, internal } from './_generated/api';
import type { DataModel } from './_generated/dataModel';
import betterAuthSchema from './betterAuth/schema';
import { makeTestConvex } from './testHelpers';

type ComponentMutationCtx = GenericMutationCtx<DataModel> &
  Pick<GenericActionCtx<DataModel>, 'storage'>;

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
      accountId: input.discordUserId,
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
});
