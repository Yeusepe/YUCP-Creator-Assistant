import { createApiActorBinding } from '@yucp/shared/apiActor';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex } from './testHelpers';

process.env.CONVEX_API_SECRET = 'test-secret';
process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';

async function createDownloadServiceActorBinding() {
  const now = Date.now();
  return await createApiActorBinding(
    {
      version: 1,
      kind: 'service',
      service: 'api-server',
      scopes: ['downloads:service'],
      issuedAt: now,
      expiresAt: now + 60_000,
    },
    process.env.INTERNAL_SERVICE_AUTH_SECRET as string
  );
}

async function authenticatedReadyVersionArgs<T extends Record<string, unknown>>(input: T) {
  return {
    apiSecret: 'test-secret',
    actor: await createDownloadServiceActorBinding(),
    ...input,
  };
}

describe('packageVersions', () => {
  it('inserts a READY package version reference with the stable channel by default', async () => {
    const t = makeTestConvex();
    const createdAt = Date.now();

    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        packageId: 'com.yucp.avatar-tools',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000001',
        totalSize: 1_024,
        contentType: 'application/zip',
        createdAt,
      })
    );

    const rows = await t.run(async (ctx) => await ctx.db.query('package_versions_ref').collect());

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      packageId: 'com.yucp.avatar-tools',
      version: '1.0.0',
      versionId: '00000000-0000-4000-8000-000000000001',
      channel: 'stable',
      state: 'READY',
      totalSize: 1_024,
      contentType: 'application/zip',
      createdAt,
    });
  });

  it('supersedes the prior READY reference for the same package and channel', async () => {
    const t = makeTestConvex();

    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        packageId: 'com.yucp.avatar-tools',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000001',
        channel: 'stable',
        createdAt: 1_000,
      })
    );
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        packageId: 'com.yucp.avatar-tools',
        version: '1.1.0',
        versionId: '00000000-0000-4000-8000-000000000002',
        channel: 'stable',
        createdAt: 2_000,
      })
    );

    const rows = await t.run(
      async (ctx) =>
        await ctx.db
          .query('package_versions_ref')
          .withIndex('by_package_channel', (q) =>
            q.eq('packageId', 'com.yucp.avatar-tools').eq('channel', 'stable')
          )
          .collect()
    );

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.version === '1.0.0')?.state).toBe('SUPERSEDED');
    expect(rows.find((row) => row.version === '1.1.0')?.state).toBe('READY');
  });

  it('does not duplicate an at-least-once READY event for the same versionId', async () => {
    const t = makeTestConvex();
    const input = {
      packageId: 'com.yucp.avatar-tools',
      version: '1.0.0',
      versionId: '00000000-0000-4000-8000-000000000001',
      channel: 'beta',
      createdAt: 1_000,
    } as const;

    const firstId = await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs(input)
    );
    const secondId = await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs(input)
    );
    const rows = await t.run(
      async (ctx) =>
        await ctx.db
          .query('package_versions_ref')
          .withIndex('by_version_id', (q) => q.eq('versionId', input.versionId))
          .collect()
    );

    expect(secondId).toBe(firstId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('READY');
  });

  it('resolves the latest READY reference by product or package and returns null when absent', async () => {
    const t = makeTestConvex();
    const catalogProductId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert('product_catalog', {
        authUserId: 'creator-package-versions',
        productId: 'avatar-tools-product',
        provider: 'gumroad',
        providerProductRef: 'gumroad-avatar-tools',
        status: 'active',
        supportsAutoDiscovery: true,
        createdAt: now,
        updatedAt: now,
      });
    });

    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        packageId: 'com.yucp.avatar-tools',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000001',
        catalogProductId,
        createdAt: 1_000,
      })
    );
    await t.mutation(
      api.packageVersions.upsertReadyVersion,
      await authenticatedReadyVersionArgs({
        packageId: 'com.yucp.avatar-tools',
        version: '1.1.0',
        versionId: '00000000-0000-4000-8000-000000000002',
        catalogProductId,
        createdAt: 2_000,
      })
    );

    const actor = await createDownloadServiceActorBinding();
    const byProduct = await t.query(api.packageVersions.resolveDownloadableVersion, {
      apiSecret: 'test-secret',
      actor,
      catalogProductId,
    });
    const byPackage = await t.query(api.packageVersions.resolveDownloadableVersion, {
      apiSecret: 'test-secret',
      actor,
      packageId: 'com.yucp.avatar-tools',
    });
    const absent = await t.query(api.packageVersions.resolveDownloadableVersion, {
      apiSecret: 'test-secret',
      actor,
      packageId: 'com.yucp.missing',
    });

    expect(byProduct?.versionId).toBe('00000000-0000-4000-8000-000000000002');
    expect(byProduct?.state).toBe('READY');
    expect(byPackage?.versionId).toBe('00000000-0000-4000-8000-000000000002');
    expect(absent).toBeNull();
  });
});
