import { createApiActorBinding } from '@yucp/shared/apiActor';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { makeTestConvex } from './testHelpers';

process.env.CONVEX_API_SECRET = 'test-secret';
process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';

async function createServiceActorBinding(scopes: readonly string[]) {
  const now = Date.now();
  return await createApiActorBinding(
    {
      version: 1,
      kind: 'service',
      service: 'api-server',
      scopes: [...scopes],
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

  it('allows actor-protected package lookups used by hosted verification helpers', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.lookup',
      packageName: 'Lookup Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-lookup',
    });

    const registration = await t.query(api.packageRegistry.lookupRegistration, {
      apiSecret: 'test-secret',
      actor: await createServiceActorBinding(['verification-intents:service']),
      packageId: 'pkg.lookup',
    });

    expect(registration).toEqual({
      packageId: 'pkg.lookup',
      yucpUserId: 'auth-user-lookup',
      status: 'active',
    });
  });

  it('does not disclose the owning creator on a package namespace conflict', async () => {
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
});
