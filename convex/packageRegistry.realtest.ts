import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { makeTestConvex } from './testHelpers';
import { createApiActorBinding } from '@yucp/shared/apiActor';

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
});
