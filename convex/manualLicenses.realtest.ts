import { beforeEach, describe, expect, it } from 'vitest';
import { createApiActorBinding } from '@yucp/shared/apiActor';
import { sha256Hex } from '@yucp/shared/crypto';
import { api } from './_generated/api';
import {
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

describe('manual license bounds', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-secret';
    process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';
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
    await t.mutation(api.manualLicenses.revoke, {
      apiSecret: 'test-secret',
      actor,
      authUserId,
      licenseId,
      reason: 'retry must be idempotent',
    });

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
});
