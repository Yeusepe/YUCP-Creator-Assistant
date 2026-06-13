import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Auth } from '../auth';

const apiMock = {
  packageRegistry: {
    listForAuthUser: 'packageRegistry.listForAuthUser',
    renameForAuthUser: 'packageRegistry.renameForAuthUser',
    deleteForAuthUser: 'packageRegistry.deleteForAuthUser',
    archiveForAuthUser: 'packageRegistry.archiveForAuthUser',
    restoreForAuthUser: 'packageRegistry.restoreForAuthUser',
  },
} as const;

const queryMock = mock(async (_ref: unknown, _args?: unknown): Promise<unknown> => undefined);
const mutationMock = mock(async (_ref: unknown, _args?: unknown): Promise<unknown> => undefined);

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
  internal: apiMock,
  components: {},
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    query: queryMock,
    mutation: mutationMock,
  }),
}));

mock.module('../lib/csrf', () => ({
  rejectCrossSiteRequest: () => null,
}));

const { createPackageRoutes } = await import('./packages');

function expectDelegatedArgs(
  args: unknown,
  expected: {
    apiSecret: string;
    authUserId: string;
    packageId?: string;
    packageName?: string;
  }
): void {
  expect(args).toEqual(
    expect.objectContaining({
      ...expected,
      actor: {
        payload: expect.any(String),
        signature: expect.any(String),
      },
    })
  );
}

describe('package routes', () => {
  const auth = {
    getSession: async () => ({ user: { id: 'creator-user' } }),
  } as unknown as Auth;

  const routes = createPackageRoutes(auth, {
    apiBaseUrl: 'http://localhost:3001',
    frontendBaseUrl: 'http://localhost:3000',
    convexApiSecret: 'convex-secret',
    convexSiteUrl: 'http://convex.site',
    convexUrl: 'http://convex.invalid',
  });

  beforeEach(() => {
    queryMock.mockReset();
    mutationMock.mockReset();
  });

  it('lists owned packages with human-readable names', async () => {
    queryMock.mockImplementation(async (ref: unknown, args: unknown) => {
      if (ref === apiMock.packageRegistry.listForAuthUser) {
        expectDelegatedArgs(args, {
          apiSecret: 'convex-secret',
          authUserId: 'creator-user',
        });
        return {
          packages: [
            {
              packageId: 'pkg.creator.bundle',
              packageName: 'Creator Bundle',
              registeredAt: 1,
              updatedAt: 2,
              status: 'active',
              archivedAt: undefined,
              canDelete: false,
              deleteBlockedReason: 'Package has signing or license history and cannot be deleted.',
              canArchive: true,
              canRestore: false,
            },
          ],
        };
      }
      throw new Error(`Unexpected query ${String(ref)}`);
    });

    const response = await routes.listPackages(
      new Request('http://localhost:3001/api/packages', { method: 'GET' })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      packages: [
        {
          packageId: 'pkg.creator.bundle',
          packageName: 'Creator Bundle',
          registeredAt: 1,
          updatedAt: 2,
          status: 'active',
          archivedAt: undefined,
          canDelete: false,
          deleteBlockedReason: 'Package has signing or license history and cannot be deleted.',
          canArchive: true,
          canRestore: false,
        },
      ],
    });
  });

  it('renames a package owned by the current creator', async () => {
    mutationMock.mockImplementation(async (ref: unknown, args: unknown) => {
      if (ref === apiMock.packageRegistry.renameForAuthUser) {
        expectDelegatedArgs(args, {
          apiSecret: 'convex-secret',
          authUserId: 'creator-user',
          packageId: 'pkg.creator.bundle',
          packageName: 'Creator Bundle+',
        });
        return {
          updated: true,
          packageId: 'pkg.creator.bundle',
          packageName: 'Creator Bundle+',
        };
      }
      throw new Error(`Unexpected mutation ${String(ref)}`);
    });

    const response = await routes.renamePackage(
      new Request('http://localhost:3001/api/packages/pkg.creator.bundle', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageName: 'Creator Bundle+' }),
      }),
      'pkg.creator.bundle'
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      updated: true,
      packageId: 'pkg.creator.bundle',
      packageName: 'Creator Bundle+',
    });
  });

  it('returns a conflict when an archived package is renamed', async () => {
    mutationMock.mockImplementation(async (ref: unknown, _args: unknown) => {
      if (ref === apiMock.packageRegistry.renameForAuthUser) {
        return {
          updated: false,
          reason: 'Archived packages cannot be updated. Restore the package before renaming it.',
        };
      }
      throw new Error(`Unexpected mutation ${String(ref)}`);
    });

    const response = await routes.renamePackage(
      new Request('http://localhost:3001/api/packages/pkg.creator.bundle', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageName: 'Creator Bundle+' }),
      }),
      'pkg.creator.bundle'
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Archived packages cannot be updated. Restore the package before renaming it.',
    });
  });

  it('returns a conflict when a package cannot be deleted safely', async () => {
    mutationMock.mockImplementation(async (ref: unknown, _args: unknown) => {
      if (ref === apiMock.packageRegistry.deleteForAuthUser) {
        return {
          deleted: false,
          reason: 'Package has signing or license history and cannot be deleted.',
        };
      }
      throw new Error(`Unexpected mutation ${String(ref)}`);
    });

    const response = await routes.deletePackage(
      new Request('http://localhost:3001/api/packages/pkg.creator.bundle', {
        method: 'DELETE',
      }),
      'pkg.creator.bundle'
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Package has signing or license history and cannot be deleted.',
    });
  });

  it('archives a package owned by the current creator', async () => {
    mutationMock.mockImplementation(async (ref: unknown, args: unknown) => {
      if (ref === apiMock.packageRegistry.archiveForAuthUser) {
        expectDelegatedArgs(args, {
          apiSecret: 'convex-secret',
          authUserId: 'creator-user',
          packageId: 'pkg.creator.bundle',
        });
        return {
          archived: true,
          packageId: 'pkg.creator.bundle',
        };
      }
      throw new Error(`Unexpected mutation ${String(ref)}`);
    });

    const response = await routes.archivePackage(
      new Request('http://localhost:3001/api/packages/pkg.creator.bundle/archive', {
        method: 'POST',
      }),
      'pkg.creator.bundle'
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      archived: true,
      packageId: 'pkg.creator.bundle',
    });
  });

  it('restores an archived package owned by the current creator', async () => {
    mutationMock.mockImplementation(async (ref: unknown, args: unknown) => {
      if (ref === apiMock.packageRegistry.restoreForAuthUser) {
        expectDelegatedArgs(args, {
          apiSecret: 'convex-secret',
          authUserId: 'creator-user',
          packageId: 'pkg.creator.bundle',
        });
        return {
          restored: true,
          packageId: 'pkg.creator.bundle',
        };
      }
      throw new Error(`Unexpected mutation ${String(ref)}`);
    });

    const response = await routes.restorePackage(
      new Request('http://localhost:3001/api/packages/pkg.creator.bundle/restore', {
        method: 'POST',
      }),
      'pkg.creator.bundle'
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      restored: true,
      packageId: 'pkg.creator.bundle',
    });
  });
});
