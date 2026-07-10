import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiActorBinding } from '@yucp/shared/apiActor';
import { sha256Hex } from '@yucp/shared/crypto';
import { api, internal } from './_generated/api';
import {
  ACTIVE_ENTITLEMENT_SOURCE_REVOCATION_BATCH_SIZE,
  MANUAL_LICENSE_ENTITLEMENT_CASCADE_WRITE_BUDGET,
  calculateManualLicenseEntitlementCascadeBatchSize,
} from './entitlements';
import {
  type ConvexTestInstance,
  makeTestConvex,
  seedEntitlement,
  seedGuildLink,
  seedRoleRule,
  seedSubject,
} from './testHelpers';

async function createAuthUserActor(authUserId: string) {
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

async function collectCascadeArtifacts(
  t: ConvexTestInstance,
  authUserId: string,
  entitlementIds: ReadonlySet<string>
) {
  return await t.run(async (ctx) => {
    const [jobs, audits] = await Promise.all([
      ctx.db
        .query('outbox_jobs')
        .withIndex('by_auth_user_type', (q) =>
          q.eq('authUserId', authUserId).eq('jobType', 'role_removal')
        )
        .collect(),
      ctx.db
        .query('audit_events')
        .withIndex('by_auth_user_event', (q) =>
          q.eq('authUserId', authUserId).eq('eventType', 'entitlement.revoked')
        )
        .collect(),
    ]);

    return {
      roleRemovalJobs: jobs.filter((job) => entitlementIds.has(String(job.payload.entitlementId))),
      revocationAudits: audits.filter(
        (audit) =>
          audit.entitlementId !== undefined && entitlementIds.has(String(audit.entitlementId))
      ),
    };
  });
}

describe('manual license bounds', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-secret';
    process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects bulkCreate requests above the documented 100-license limit', async () => {
    const t = makeTestConvex();
    const actor = await createAuthUserActor('auth-manual-bounds');

    await expect(
      t.mutation(api.manualLicenses.bulkCreate, {
        apiSecret: 'test-secret',
        actor,
        authUserId: 'auth-manual-bounds',
        licenses: Array.from({ length: 101 }, (_, index) => ({
          licenseKeyHash: `${index}`.padStart(64, '0'),
          productId: `product-${index}`,
        })),
      })
    ).rejects.toThrow('Maximum of 100 licenses per bulk request');
  });

  it('revokes legacy active entitlements when retrying an already-revoked manual license', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-manual-legacy-revoke';
    const productId = 'product-manual-legacy-revoke';
    const actor = await createAuthUserActor(authUserId);
    const subjectId = await seedSubject(t, {
      authUserId: 'auth-manual-legacy-buyer',
      primaryDiscordUserId: 'discord-manual-legacy-revoke',
    });
    const guildLinkId = await seedGuildLink(t, {
      authUserId,
      discordGuildId: 'guild-manual-legacy-revoke',
      installedByAuthUserId: authUserId,
    });
    await seedRoleRule(t, guildLinkId, {
      authUserId,
      guildId: 'guild-manual-legacy-revoke',
      productId,
      verifiedRoleId: 'role-manual-legacy-revoke',
      removeOnRevoke: true,
    });

    const { licenseId } = await t.mutation(api.manualLicenses.create, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      licenseKeyHash: 'legacy-license-key-hash',
      productId,
      notes: 'Revoked before entitlement cascade existed',
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(licenseId, { status: 'revoked' });
    });
    const sourceReference = `manual:${await sha256Hex(String(licenseId))}`;
    const entitlementId = await seedEntitlement(t, subjectId, {
      authUserId,
      productId,
      sourceProvider: 'manual',
      sourceReference,
      status: 'active',
    });

    await t.mutation(api.manualLicenses.revoke, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      licenseId,
      reason: 'retry legacy cleanup',
    });
    vi.runAllTimers();
    await t.finishInProgressScheduledFunctions();
    await t.mutation(api.manualLicenses.revoke, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      licenseId,
      reason: 'retry must be idempotent',
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const [license, entitlement, roleRemovalJobs, entitlementRevocations] = await t.run(
      async (ctx) => {
        const currentLicense = await ctx.db.get(licenseId);
        const currentEntitlement = await ctx.db.get(entitlementId);
        const currentRoleRemovalJobs = await ctx.db
          .query('outbox_jobs')
          .withIndex('by_auth_user_type', (q) =>
            q.eq('authUserId', authUserId).eq('jobType', 'role_removal')
          )
          .collect();
        const currentEntitlementRevocations = await ctx.db
          .query('audit_events')
          .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
          .filter((q) => q.eq(q.field('eventType'), 'entitlement.revoked'))
          .collect();
        return [
          currentLicense,
          currentEntitlement,
          currentRoleRemovalJobs,
          currentEntitlementRevocations,
        ] as const;
      }
    );

    expect(license).toMatchObject({
      status: 'revoked',
      notes: 'Revoked before entitlement cascade existed',
    });
    expect(entitlement).toMatchObject({ status: 'revoked' });
    expect(roleRemovalJobs).toHaveLength(1);
    expect(roleRemovalJobs[0]?.payload).toMatchObject({
      subjectId,
      entitlementId,
      guildId: 'guild-manual-legacy-revoke',
      roleId: 'role-manual-legacy-revoke',
    });
    expect(entitlementRevocations).toHaveLength(1);
  });

  it('does not mutate an already-revoked manual license that has no active linked entitlement', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-manual-clean-revoke';
    const actor = await createAuthUserActor(authUserId);
    const { licenseId } = await t.mutation(api.manualLicenses.create, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      licenseKeyHash: 'clean-license-key-hash',
      productId: 'product-manual-clean-revoke',
      notes: 'Already clean',
    });
    const revokedAt = 1_234_567_890;
    await t.run(async (ctx) => {
      await ctx.db.patch(licenseId, {
        status: 'revoked',
        updatedAt: revokedAt,
      });
    });

    await t.mutation(api.manualLicenses.revoke, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      licenseId,
      reason: 'must not append a duplicate note',
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const [license, roleRemovalJobs, entitlementRevocations] = await t.run(async (ctx) => {
      const currentLicense = await ctx.db.get(licenseId);
      const currentRoleRemovalJobs = await ctx.db
        .query('outbox_jobs')
        .withIndex('by_auth_user_type', (q) =>
          q.eq('authUserId', authUserId).eq('jobType', 'role_removal')
        )
        .collect();
      const currentEntitlementRevocations = await ctx.db
        .query('audit_events')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
        .filter((q) => q.eq(q.field('eventType'), 'entitlement.revoked'))
        .collect();
      return [currentLicense, currentRoleRemovalJobs, currentEntitlementRevocations] as const;
    });

    expect(license).toMatchObject({
      status: 'revoked',
      notes: 'Already clean',
      updatedAt: revokedAt,
    });
    expect(roleRemovalJobs).toHaveLength(0);
    expect(entitlementRevocations).toHaveLength(0);
  });

  it('commits reusable-license revocation before draining the bounded entitlement cascade', async () => {
    // One more than the production chunk size proves the cascade reschedules
    // instead of processing every linked redemption in one transaction. Twenty-five
    // removable roles make the role fanout reduce the entitlement batch below
    // the fixed page limit while keeping the realtest fast enough for CI.
    const entitlementCount = ACTIVE_ENTITLEMENT_SOURCE_REVOCATION_BATCH_SIZE + 1;
    const removableRoleCount = 25;
    const writesPerEntitlement = removableRoleCount + 2;
    const expectedBatchSize = calculateManualLicenseEntitlementCascadeBatchSize(removableRoleCount);
    const t = makeTestConvex();
    try {
      const authUserId = 'auth-manual-bounded-revoke';
      const productId = 'product-manual-bounded-revoke';
      const actor = await createAuthUserActor(authUserId);
      const subjectId = await seedSubject(t, {
        authUserId: 'auth-manual-bounded-buyer',
        primaryDiscordUserId: 'discord-manual-bounded-revoke',
      });
      const guildLinkId = await seedGuildLink(t, {
        authUserId,
        discordGuildId: 'guild-manual-bounded-revoke',
        installedByAuthUserId: authUserId,
      });
      for (let roleIndex = 0; roleIndex < removableRoleCount; roleIndex++) {
        await seedRoleRule(t, guildLinkId, {
          authUserId,
          guildId: 'guild-manual-bounded-revoke',
          productId,
          verifiedRoleId: `role-manual-bounded-revoke-${roleIndex}`,
          removeOnRevoke: true,
        });
      }

      const { licenseId } = await t.mutation(api.manualLicenses.create, {
        apiSecret: 'test-secret',
        actor,
        authUserId,
        licenseKeyHash: 'bounded-license-key-hash',
        productId,
        maxUses: entitlementCount,
      });
      const sourceReference = `manual:${await sha256Hex(String(licenseId))}`;
      const entitlementIds = await Promise.all(
        Array.from({ length: entitlementCount }, () =>
          seedEntitlement(t, subjectId, {
            authUserId,
            productId,
            sourceProvider: 'manual',
            sourceReference,
          })
        )
      );

      await t.mutation(api.manualLicenses.revoke, {
        apiSecret: 'test-secret',
        actor,
        authUserId,
        licenseId,
        reason: 'creator requested bounded removal',
      });

      const [revokedLicenseBeforeDrain, activeEntitlementsBeforeDrain] = await t.run(
        async (ctx) => {
          const license = await ctx.db.get(licenseId);
          const activeEntitlements = await ctx.db
            .query('entitlements')
            .withIndex('by_auth_user_source_provider_reference_status', (q) =>
              q
                .eq('authUserId', authUserId)
                .eq('sourceProvider', 'manual')
                .eq('sourceReference', sourceReference)
                .eq('status', 'active')
            )
            .collect();
          return [license, activeEntitlements] as const;
        }
      );
      const cascadeArtifactsBeforeDrain = await collectCascadeArtifacts(
        t,
        authUserId,
        new Set(entitlementIds.map(String))
      );

      expect(revokedLicenseBeforeDrain).toMatchObject({ status: 'revoked' });
      expect(activeEntitlementsBeforeDrain).toHaveLength(entitlementCount);
      expect(cascadeArtifactsBeforeDrain.roleRemovalJobs).toHaveLength(0);
      expect(cascadeArtifactsBeforeDrain.revocationAudits).toHaveLength(0);

      const firstChunk = await t.mutation(
        internal.entitlements.revokeManualLicenseEntitlementCascadeChunk,
        {
          authUserId,
          sourceReference,
          correlationId: `manual-license:${licenseId}`,
          revokedAt: Date.now(),
        }
      );

      expect(expectedBatchSize).toBeLessThan(ACTIVE_ENTITLEMENT_SOURCE_REVOCATION_BATCH_SIZE);
      expect(expectedBatchSize * writesPerEntitlement).toBeLessThanOrEqual(
        MANUAL_LICENSE_ENTITLEMENT_CASCADE_WRITE_BUDGET
      );
      expect(firstChunk).toMatchObject({
        revokedCount: expectedBatchSize,
        writesPerEntitlement,
        estimatedWriteCount: expectedBatchSize * writesPerEntitlement,
        hop: 0,
        revokedTotal: expectedBatchSize,
      });

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const revokedEntitlements = await t.run(async (ctx) => {
        const entitlements = await ctx.db
          .query('entitlements')
          .withIndex('by_auth_user_source_provider_reference_status', (q) =>
            q
              .eq('authUserId', authUserId)
              .eq('sourceProvider', 'manual')
              .eq('sourceReference', sourceReference)
          )
          .collect();
        return entitlements;
      });
      const cascadeArtifactsAfterDrain = await collectCascadeArtifacts(
        t,
        authUserId,
        new Set(entitlementIds.map(String))
      );

      expect(revokedEntitlements).toHaveLength(entitlementCount);
      expect(revokedEntitlements.every((entitlement) => entitlement.status === 'revoked')).toBe(
        true
      );
      expect(cascadeArtifactsAfterDrain.roleRemovalJobs).toHaveLength(
        entitlementCount * removableRoleCount
      );
      expect(cascadeArtifactsAfterDrain.revocationAudits).toHaveLength(entitlementCount);

      await t.mutation(api.manualLicenses.revoke, {
        apiSecret: 'test-secret',
        actor,
        authUserId,
        licenseId,
        reason: 'retry must not duplicate removals',
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      await t.mutation(internal.entitlements.revokeManualLicenseEntitlementCascadeChunk, {
        authUserId,
        sourceReference,
        correlationId: `manual-license:${licenseId}`,
        revokedAt: Date.now(),
      });

      const cascadeArtifactsAfterRetry = await collectCascadeArtifacts(
        t,
        authUserId,
        new Set(entitlementIds.map(String))
      );

      expect(cascadeArtifactsAfterRetry.roleRemovalJobs).toHaveLength(
        entitlementCount * removableRoleCount
      );
      expect(cascadeArtifactsAfterRetry.revocationAudits).toHaveLength(entitlementCount);
    } finally {
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    }
  });

  it('returns a filtered cursor page without exposing license hashes', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-manual-pagination';
    const now = Date.now();
    const actor = await createApiActorBinding(
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

    const ids = await t.run(async (ctx) =>
      Promise.all(
        ['license-a', 'license-b', 'license-c'].map(async (licenseKeyHash, index) =>
          await ctx.db.insert('manual_licenses', {
            authUserId,
            licenseKeyHash,
            productId: 'product-pagination',
            currentUses: 0,
            status: 'active',
            createdAt: now + index,
            updatedAt: now + index,
          })
        )
      )
    );

    const firstPage = await t.query(api.manualLicenses.listByTenant, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      productId: 'product-pagination',
      limit: 2,
    });

    expect(firstPage).toMatchObject({ hasMore: true });
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.data.every((license) => !('licenseKeyHash' in license))).toBe(true);
    const firstCursor = firstPage.nextCursor;
    if (!firstCursor) {
      throw new Error('Expected the first manual-license page to include a cursor');
    }

    const secondPage = await t.query(api.manualLicenses.listByTenant, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      productId: 'product-pagination',
      cursor: firstCursor,
      limit: 2,
    });

    expect(secondPage).toMatchObject({ hasMore: false, nextCursor: null });
    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.data[0]?._id).toBe(ids[2]);
  });
});
