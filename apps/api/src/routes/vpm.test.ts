import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { createTestLogger } from '../testSupport/loggerMock';
import type { VpmRouteConfig } from './vpm';

const convexQueryMock = mock(async (_reference?: unknown, _args?: unknown) => null as unknown);
const convexMutationMock = mock(async (_reference?: unknown, _args?: unknown) => null as unknown);
const creatorProfileQueryMock = mock(async (_args?: unknown) => ({
  authUserId: 'creator-auth',
  name: 'Mapache',
  slug: 'mapache',
  status: 'active',
}));
const deliverySlugMutationMock = mock(async (_args?: unknown) => ({
  created: false,
  slug: 'mapache',
}));
const loggerErrorMock = mock(() => undefined);
const importerIndexFetchMock = mock(async () =>
  Response.json({
    packages: {
      'com.yucp.importer': {
        versions: {
          '0.1.36': {
            name: 'com.yucp.importer',
            displayName: 'YUCP Package Importer',
            version: '0.1.36',
            unity: '2022.3',
            description: 'YUCP package importer',
            author: {
              name: 'YUCP Club',
              url: 'https://vpm.yucp.club/',
            },
            zipSHA256: 'b8f611e191f4fc796c84c3a52f55f5c3b7e62acdf574962a0499aade61533380',
            url: 'https://packages.example.test/com.yucp.importer-0.1.36.zip',
          },
        },
      },
    },
  })
);

const apiMock = {
  creatorProfiles: {
    ensureDeliverySlug: 'creatorProfiles.ensureDeliverySlug',
    getCreatorProfile: 'creatorProfiles.getCreatorProfile',
    resolveDeliveryNamespace: 'creatorProfiles.resolveDeliveryNamespace',
  },
  creatorVpmLinks: {
    ensureActive: 'creatorVpmLinks.ensureActive',
    getActiveByLinkId: 'creatorVpmLinks.getActiveByLinkId',
    getActiveForCreator: 'creatorVpmLinks.getActiveForCreator',
    revokeActive: 'creatorVpmLinks.revokeActive',
  },
  packageRegistry: {
    getByPackageIdForAuthUser: 'packageRegistry.getByPackageIdForAuthUser',
  },
  packageVersions: {
    resolvePublicBootstrapPresentation: 'packageVersions.resolvePublicBootstrapPresentation',
  },
  vpmAliasPublications: {
    commitPublicationForService: 'vpmAliasPublications.commitPublicationForService',
    getLatestPublishedForPackage: 'vpmAliasPublications.getLatestPublishedForPackage',
    getPresentationForService: 'vpmAliasPublications.getPresentationForService',
    getPublishedByPublicationId: 'vpmAliasPublications.getPublishedByPublicationId',
    listPublishedForPackage: 'vpmAliasPublications.listPublishedForPackage',
    markPublicationFailedForService: 'vpmAliasPublications.markPublicationFailedForService',
    reservePublicationForService: 'vpmAliasPublications.reservePublicationForService',
    seedPresentationIfMissingForCreator: 'vpmAliasPublications.seedPresentationIfMissingForCreator',
    updatePresentationForCreator: 'vpmAliasPublications.updatePresentationForCreator',
  },
} as const;

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
  components: {},
  internal: {},
}));

mock.module('../lib/apiActor', () => ({
  createApiServiceActorBinding: async () => 'vpm-service-actor',
  createAuthUserActorBinding: async () => 'creator-vpm-actor',
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: (_url: string, actor?: unknown) => ({
    query: (reference: unknown, args?: unknown) => {
      const boundArgs =
        args && typeof args === 'object' && 'apiSecret' in args
          ? { ...(args as Record<string, unknown>), actor }
          : args;
      return reference === apiMock.creatorProfiles.getCreatorProfile
        ? creatorProfileQueryMock(boundArgs)
        : convexQueryMock(reference, boundArgs);
    },
    mutation: (reference: unknown, args?: unknown) => {
      const boundArgs =
        args && typeof args === 'object' && 'apiSecret' in args
          ? { ...(args as Record<string, unknown>), actor }
          : args;
      return reference === apiMock.creatorProfiles.ensureDeliverySlug
        ? deliverySlugMutationMock(boundArgs)
        : convexMutationMock(reference, boundArgs);
    },
  }),
}));

mock.module('../lib/logger', () => ({
  logger: createTestLogger({
    error: loggerErrorMock,
    info: mock(() => undefined),
    warn: mock(() => undefined),
  }),
}));

const { createVpmRoutes } = await import('./vpm');

const config = {
  apiBaseUrl: 'https://api.test',
  frontendBaseUrl: 'https://app.test',
  convexApiSecret: 'test-convex-secret',
  convexUrl: 'https://convex.test',
  privateVpmRootDomain: 'private.yucp.club',
  publicVpmIndexUrl: 'https://vpm.yucp.club/index.json',
  vpmBaseUrl: 'https://vpm.test/',
};

type ArtifactStore = {
  bucketName: string;
  publish(input: {
    body: Uint8Array;
    bootstrapVersion: string;
    packageId: string;
    publicationId: string;
    sha256: string;
  }): Promise<{
    bucketName: string;
    byteSize: number;
    contentType: 'application/zip';
    objectKey: string;
    providerVersion: string;
    sha256: string;
  }>;
  readExact(reference: unknown): Promise<Uint8Array>;
};

function createRoutes(
  userId: string | null,
  options: {
    aliasArtifactStore?: ArtifactStore;
    bootstrapMediaReader?: { readExact(reference: unknown): Promise<Uint8Array> };
    config?: Partial<VpmRouteConfig>;
    privateDomainProvisioner?: {
      ensureDomain(hostname: string): Promise<{ hostname: string; status: 'active' }>;
    };
  } = {}
) {
  const aliasArtifactStore: ArtifactStore = options.aliasArtifactStore ?? {
    bucketName: 'metadata',
    publish: async () => {
      throw new Error('Unexpected VPM alias publication');
    },
    readExact: async () => {
      throw new Error('Unexpected VPM alias artifact read');
    },
  };
  return createVpmRoutes({
    auth: {
      getSession: async () => (userId ? { user: { id: userId } } : null),
    } as never,
    aliasArtifactStore: aliasArtifactStore as never,
    ...(options.bootstrapMediaReader
      ? { bootstrapMediaReader: options.bootstrapMediaReader as never }
      : {}),
    privateDomainProvisioner: options.privateDomainProvisioner ?? {
      ensureDomain: async (hostname) => ({ hostname, status: 'active' as const }),
    },
    config: { ...config, ...options.config },
    fetchImpl: importerIndexFetchMock as unknown as typeof fetch,
  });
}

function product() {
  return {
    _id: 'catalog_jammr',
    aliasId: 'jammr',
    catalogProductIds: ['catalog_jammr_gumroad', 'catalog_jammr_jinxxy'],
    creatorAuthUserId: 'creator-auth',
    displayName: 'JAMMR',
    packageId: 'com.yucp.jammr',
  };
}

function artifactReference(input: {
  bootstrapVersion: string;
  publicationId: string;
  sha256: string;
}) {
  return {
    bucketName: 'metadata',
    byteSize: 64,
    contentType: 'application/zip' as const,
    objectKey: `indexes/vpm/aliases/package/${input.publicationId}/${input.bootstrapVersion}.zip`,
    providerVersion: `exact-${input.bootstrapVersion}`,
    sha256: input.sha256,
  };
}

function publishedAlias(input: {
  bootstrapVersion: string;
  publicationId: string;
  publishedAt: number;
}) {
  const aliasPackageId = 'com.yucp.alias.0123456789abcdef0123456789abcdef';
  const sha256 = createHash('sha256').update(input.publicationId, 'utf8').digest('hex');
  const manifest = {
    name: aliasPackageId,
    displayName: 'JAMMR',
    version: input.bootstrapVersion,
    unity: '2022.3',
    description: 'Adds JAMMR after purchase verification.',
    author: {
      name: 'Mapache',
      email: 'contact@yucp.club',
      url: 'https://yucp.club/',
    },
    vpmDependencies: {
      'com.yucp.importer': '>=0.1.36',
    },
    yucp: {
      kind: 'alias-v1',
      aliasId: 'com.yucp.jammr',
      installStrategy: 'server-authorized',
      importerPackage: 'com.yucp.importer',
      minImporterVersion: '0.1.36',
    },
    url: `https://mapache.private.yucp.club/api/vpm/alias-publications/${input.publicationId}/${input.bootstrapVersion}.zip`,
    zipSHA256: sha256,
  };
  const repositoryManifestJson = JSON.stringify(manifest);
  return {
    aliasPackageId,
    artifact: artifactReference({
      bootstrapVersion: input.bootstrapVersion,
      publicationId: input.publicationId,
      sha256,
    }),
    bootstrapVersion: input.bootstrapVersion,
    channel: 'stable',
    contractVersion: 1,
    createdAt: input.publishedAt - 1,
    packageId: 'com.yucp.jammr',
    presentationFingerprintSha256: 'f'.repeat(64),
    publicationId: input.publicationId,
    publishedAt: input.publishedAt,
    repositoryManifestJson,
    repositoryManifestSha256: createHash('sha256').update(repositoryManifestJson).digest('hex'),
    revision: input.bootstrapVersion === '1.0.0' ? 1 : 2,
    status: 'PUBLISHED' as const,
  };
}

function link(linkId = 'L'.repeat(43)) {
  return {
    createdAt: 100,
    creatorSlug: 'mapache',
    linkId,
    packageId: 'com.yucp.jammr',
    status: 'active' as const,
  };
}

function creatorMutationRequest(method: 'POST' | 'DELETE', traceparent?: string) {
  return new Request('https://api.test/api/creator/packages/by-package/com.yucp.jammr/vcc-link', {
    method,
    headers: {
      Origin: 'https://app.test',
      ...(traceparent ? { traceparent } : {}),
    },
  });
}

function creatorPresentationRequest(packageName: string) {
  return new Request(
    'https://api.test/api/creator/packages/by-package/com.yucp.jammr/presentation',
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://app.test',
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      },
      body: JSON.stringify({ packageName }),
    }
  );
}

describe('package-scoped VPM routes', () => {
  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    convexQueryMock.mockReset();
    convexMutationMock.mockReset();
    creatorProfileQueryMock.mockClear();
    deliverySlugMutationMock.mockClear();
    importerIndexFetchMock.mockClear();
    loggerErrorMock.mockReset();
  });

  it('returns one durable package-scoped creator link across route instances', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.getByPackageIdForAuthUser) return product();
      if (reference === apiMock.creatorVpmLinks.getActiveForCreator) return link();
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const first = await createRoutes('creator-auth').manageCreatorLink(
      new Request('https://api.test/api/creator/packages/by-package/com.yucp.jammr/vcc-link'),
      'com.yucp.jammr'
    );
    const afterRestart = await createRoutes('creator-auth').manageCreatorLink(
      new Request('https://api.test/api/creator/packages/by-package/com.yucp.jammr/vcc-link'),
      'com.yucp.jammr'
    );

    expect(first.status).toBe(200);
    expect(await afterRestart.json()).toMatchObject({
      status: 'active',
      indexUrl: `https://mapache.private.yucp.club/api/vpm/access/${'L'.repeat(43)}/index.json`,
    });
  });

  it('never returns the shared VPM origin when private creator delivery is unconfigured', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.getByPackageIdForAuthUser) return product();
      if (reference === apiMock.creatorVpmLinks.getActiveForCreator) return link();
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes('creator-auth', {
      config: {
        privateVpmRootDomain: undefined,
      },
    }).manageCreatorLink(
      new Request('https://api.test/api/creator/packages/by-package/com.yucp.jammr/vcc-link'),
      'com.yucp.jammr'
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain('vpm.test');
  });

  it('creates the first immutable alias publication when the creator activates a link', async () => {
    const presentation = {
      artifactBaseUrl: 'https://mapache.private.yucp.club',
      artifactBucketName: 'metadata',
      authorName: 'Mapache',
      channel: 'stable',
      description: 'Adds JAMMR after purchase verification.',
      media: [],
      minImporterVersion: '0.1.36',
      packageId: 'com.yucp.jammr',
      packageName: 'JAMMR',
      presentationFingerprintSha256: 'f'.repeat(64),
      unityVersion: '2022.3',
    };
    let presentationSeeded = false;
    let reservationInput: Record<string, unknown> | undefined;
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.getByPackageIdForAuthUser) return product();
      if (reference === apiMock.vpmAliasPublications.getPresentationForService) {
        return presentationSeeded ? presentation : null;
      }
      if (reference === apiMock.packageVersions.resolvePublicBootstrapPresentation) {
        return {
          bootstrapMedia: [],
          packageMetadata: {
            author: 'Mapache',
            packageName: 'JAMMR',
          },
        };
      }
      if (reference === apiMock.creatorProfiles.getCreatorProfile) {
        return { name: 'Mapache' };
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });
    let committed: Record<string, unknown> | undefined;
    convexMutationMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.creatorVpmLinks.ensureActive) return link();
      if (reference === apiMock.vpmAliasPublications.seedPresentationIfMissingForCreator) {
        presentationSeeded = true;
        return {
          created: true,
          changed: true,
          packageId: 'com.yucp.jammr',
          channel: 'stable',
          presentationFingerprintSha256: 'f'.repeat(64),
          updatedAt: 1,
        };
      }
      if (reference === apiMock.vpmAliasPublications.reservePublicationForService) {
        reservationInput = args as Record<string, unknown>;
        return {
          bootstrapVersion: '1.0.0',
          channel: 'stable',
          created: true,
          packageId: 'com.yucp.jammr',
          presentationFingerprintSha256: 'f'.repeat(64),
          publicationId: '00000000-0000-4000-8000-000000000201',
          revision: 1,
          status: 'PREPARING',
        };
      }
      if (reference === apiMock.vpmAliasPublications.commitPublicationForService) {
        committed = args as Record<string, unknown>;
        return { status: 'PUBLISHED' };
      }
      throw new Error(`Unexpected mutation ${String(reference)}`);
    });
    const publish = mock(async (input: { body: Uint8Array; sha256: string }) => ({
      ...artifactReference({
        bootstrapVersion: '1.0.0',
        publicationId: '00000000-0000-4000-8000-000000000201',
        sha256: input.sha256,
      }),
      byteSize: input.body.byteLength,
    }));

    const response = await createRoutes('creator-auth', {
      aliasArtifactStore: {
        bucketName: 'metadata',
        publish,
        readExact: mock(async () => new Uint8Array()),
      },
    }).manageCreatorLink(
      creatorMutationRequest('POST', '00-11111111111111111111111111111111-2222222222222222-01'),
      'com.yucp.jammr'
    );

    expect(response.status).toBe(200);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(committed).toMatchObject({
      publicationId: '00000000-0000-4000-8000-000000000201',
    });
    expect(reservationInput).toMatchObject({
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    });
    expect(JSON.stringify(committed)).not.toContain('catalog_jammr');
    expect(JSON.stringify(committed)).not.toContain('paid');
  });

  it('provisions and returns the creator-owned private VPM hostname', async () => {
    const presentation = {
      artifactBaseUrl: 'https://mapache.private.yucp.club',
      artifactBucketName: 'metadata',
      authorName: 'Mapache',
      channel: 'stable',
      description: 'Adds JAMMR after purchase verification.',
      media: [],
      minImporterVersion: '0.1.36',
      packageId: 'com.yucp.jammr',
      packageName: 'JAMMR',
      presentationFingerprintSha256: 'f'.repeat(64),
      unityVersion: '2022.3',
    };
    const ensureDomain = mock(async (hostname: string) => ({
      hostname,
      status: 'active' as const,
    }));
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.getByPackageIdForAuthUser) return product();
      if (reference === apiMock.creatorProfiles.getCreatorProfile) {
        return { authUserId: 'creator-auth', name: 'Mapache', slug: 'mapache', status: 'active' };
      }
      if (reference === apiMock.vpmAliasPublications.getPresentationForService) {
        return presentation;
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });
    convexMutationMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.vpmAliasPublications.reservePublicationForService) {
        return {
          bootstrapVersion: '1.0.0',
          channel: 'stable',
          created: false,
          packageId: 'com.yucp.jammr',
          presentationFingerprintSha256: 'f'.repeat(64),
          publicationId: '00000000-0000-4000-8000-000000000221',
          revision: 1,
          status: 'PUBLISHED',
        };
      }
      if (reference === apiMock.creatorVpmLinks.ensureActive) return link();
      throw new Error(`Unexpected mutation ${String(reference)}`);
    });

    const response = await createVpmRoutes({
      auth: {
        getSession: async () => ({ user: { id: 'creator-auth' } }),
      } as never,
      aliasArtifactStore: {
        bucketName: 'metadata',
        publish: mock(async () => {
          throw new Error('Published reservation must not rebuild');
        }),
        readExact: mock(async () => new Uint8Array()),
      } as never,
      config: {
        ...config,
        privateVpmRootDomain: 'private.yucp.club',
      },
      privateDomainProvisioner: {
        ensureDomain,
      },
      fetchImpl: importerIndexFetchMock as unknown as typeof fetch,
    } as never).manageCreatorLink(creatorMutationRequest('POST'), 'com.yucp.jammr');

    expect(response.status).toBe(200);
    expect(ensureDomain).toHaveBeenCalledWith('mapache.private.yucp.club');
    expect(await response.json()).toMatchObject({
      status: 'active',
      indexUrl: `https://mapache.private.yucp.club/api/vpm/access/${'L'.repeat(43)}/index.json`,
    });
  });

  it('uses the creator-owned package name when release presentation metadata is absent', async () => {
    const registryProduct = {
      ...product(),
      displayName: 'JAMMR | NEW UPDATE: Song recognition | Create or join Spotify Jams from VRChat',
      packageName: 'JAMMR',
    };
    const presentation = {
      artifactBaseUrl: 'https://mapache.private.yucp.club',
      artifactBucketName: 'metadata',
      authorName: 'Mapache',
      channel: 'stable',
      description: 'Adds JAMMR to this Unity project after purchase verification.',
      media: [],
      minImporterVersion: '0.1.36',
      packageId: 'com.yucp.jammr',
      packageName: 'JAMMR',
      presentationFingerprintSha256: 'f'.repeat(64),
      unityVersion: '2022.3',
    };
    let presentationSeeded = false;
    let seedInput: Record<string, unknown> | undefined;
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.getByPackageIdForAuthUser) return registryProduct;
      if (reference === apiMock.vpmAliasPublications.getPresentationForService) {
        return presentationSeeded ? presentation : null;
      }
      if (reference === apiMock.packageVersions.resolvePublicBootstrapPresentation) {
        return { bootstrapMedia: [] };
      }
      if (reference === apiMock.creatorProfiles.getCreatorProfile) {
        return { name: 'Mapache' };
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });
    convexMutationMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.creatorVpmLinks.ensureActive) return link();
      if (reference === apiMock.vpmAliasPublications.seedPresentationIfMissingForCreator) {
        presentationSeeded = true;
        seedInput = args as Record<string, unknown>;
        return {
          created: true,
          changed: true,
          packageId: 'com.yucp.jammr',
          channel: 'stable',
          presentationFingerprintSha256: 'f'.repeat(64),
          updatedAt: 1,
        };
      }
      if (reference === apiMock.vpmAliasPublications.reservePublicationForService) {
        return {
          bootstrapVersion: '1.0.0',
          channel: 'stable',
          created: false,
          packageId: 'com.yucp.jammr',
          presentationFingerprintSha256: 'f'.repeat(64),
          publicationId: '00000000-0000-4000-8000-000000000211',
          revision: 1,
          status: 'PUBLISHED',
        };
      }
      throw new Error(`Unexpected mutation ${String(reference)}`);
    });

    const response = await createRoutes('creator-auth', {
      aliasArtifactStore: {
        bucketName: 'metadata',
        publish: mock(async () => {
          throw new Error('Published reservation must not rebuild');
        }),
        readExact: mock(async () => new Uint8Array()),
      },
    }).manageCreatorLink(creatorMutationRequest('POST'), 'com.yucp.jammr');

    expect(response.status).toBe(200);
    expect(seedInput).toMatchObject({
      packageId: 'com.yucp.jammr',
      packageName: 'JAMMR',
    });
  });

  it('updates the creator-owned package name and publishes a new bootstrap revision', async () => {
    const previousPresentation = {
      artifactBaseUrl: 'https://mapache.private.yucp.club',
      artifactBucketName: 'metadata',
      authorName: 'Mapache',
      channel: 'stable',
      description: 'Adds the product after purchase verification.',
      media: [],
      minImporterVersion: '0.1.36',
      packageId: 'com.yucp.jammr',
      packageName: 'Storefront marketing title',
      presentationFingerprintSha256: 'e'.repeat(64),
      unityVersion: '2022.3',
    };
    const updatedPresentation = {
      ...previousPresentation,
      artifactBaseUrl: 'https://mapache.private.yucp.club',
      packageName: 'JAMMR',
      presentationFingerprintSha256: 'f'.repeat(64),
    };
    let presentationUpdated = false;
    let presentationUpdateInput: Record<string, unknown> | undefined;
    let reservationInput: Record<string, unknown> | undefined;
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.getByPackageIdForAuthUser) {
        return {
          ...product(),
          packageName: 'Storefront marketing title',
        };
      }
      if (reference === apiMock.vpmAliasPublications.getPresentationForService) {
        return presentationUpdated ? updatedPresentation : previousPresentation;
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });
    convexMutationMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.vpmAliasPublications.updatePresentationForCreator) {
        presentationUpdated = true;
        presentationUpdateInput = args as Record<string, unknown>;
        return {
          created: false,
          changed: true,
          packageId: 'com.yucp.jammr',
          channel: 'stable',
          presentationFingerprintSha256: 'f'.repeat(64),
          updatedAt: 2,
        };
      }
      if (reference === apiMock.vpmAliasPublications.reservePublicationForService) {
        reservationInput = args as Record<string, unknown>;
        return {
          bootstrapVersion: '1.0.1',
          channel: 'stable',
          created: true,
          packageId: 'com.yucp.jammr',
          presentationFingerprintSha256: 'f'.repeat(64),
          publicationId: '00000000-0000-4000-8000-000000000212',
          revision: 2,
          status: 'PREPARING',
        };
      }
      if (reference === apiMock.vpmAliasPublications.commitPublicationForService) {
        return { status: 'PUBLISHED' };
      }
      throw new Error(`Unexpected mutation ${String(reference)}`);
    });
    const publish = mock(async (input: { body: Uint8Array; sha256: string }) => ({
      ...artifactReference({
        bootstrapVersion: '1.0.1',
        publicationId: '00000000-0000-4000-8000-000000000212',
        sha256: input.sha256,
      }),
      byteSize: input.body.byteLength,
    }));
    const ensureDomain = mock(async (hostname: string) => ({
      hostname,
      status: 'active' as const,
    }));

    const routes = createRoutes('creator-auth', {
      aliasArtifactStore: {
        bucketName: 'metadata',
        publish,
        readExact: mock(async () => new Uint8Array()),
      },
      config: {
        privateVpmRootDomain: 'private.yucp.club',
      },
      privateDomainProvisioner: {
        ensureDomain,
      },
    });
    const response = await routes.manageCreatorPresentation(
      creatorPresentationRequest('JAMMR'),
      'com.yucp.jammr'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      packageName: 'JAMMR',
      published: true,
    });
    expect(presentationUpdateInput).toMatchObject({
      artifactBaseUrl: 'https://mapache.private.yucp.club',
      packageId: 'com.yucp.jammr',
      packageName: 'JAMMR',
    });
    expect(reservationInput).toMatchObject({
      publicationReason: 'presentation-update',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(ensureDomain).toHaveBeenCalledWith('mapache.private.yucp.club');
  });

  it('publishes a new immutable bootstrap when the metadata bucket changes', async () => {
    const previousPresentation = {
      artifactBaseUrl: 'https://mapache.private.yucp.club',
      artifactBucketName: 'metadata-old-epoch',
      authorName: 'Mapache',
      channel: 'stable',
      description: 'Adds JAMMR after purchase verification.',
      media: [],
      minImporterVersion: '0.1.36',
      packageId: 'com.yucp.jammr',
      packageName: 'JAMMR',
      presentationFingerprintSha256: 'e'.repeat(64),
      unityVersion: '2022.3',
    };
    const currentPresentation = {
      ...previousPresentation,
      artifactBucketName: 'metadata-current-epoch',
      presentationFingerprintSha256: 'f'.repeat(64),
    };
    let presentationUpdated = false;
    let presentationUpdateInput: Record<string, unknown> | undefined;
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.getByPackageIdForAuthUser) return product();
      if (reference === apiMock.vpmAliasPublications.getPresentationForService) {
        return presentationUpdated ? currentPresentation : previousPresentation;
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });
    convexMutationMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.creatorVpmLinks.ensureActive) return link();
      if (reference === apiMock.vpmAliasPublications.updatePresentationForCreator) {
        presentationUpdated = true;
        presentationUpdateInput = args as Record<string, unknown>;
        return {
          created: false,
          changed: true,
          packageId: 'com.yucp.jammr',
          channel: 'stable',
          presentationFingerprintSha256: 'f'.repeat(64),
          updatedAt: 2,
        };
      }
      if (reference === apiMock.vpmAliasPublications.reservePublicationForService) {
        return {
          bootstrapVersion: '1.0.2',
          channel: 'stable',
          created: true,
          packageId: 'com.yucp.jammr',
          presentationFingerprintSha256: 'f'.repeat(64),
          publicationId: '00000000-0000-4000-8000-000000000213',
          revision: 3,
          status: 'PREPARING',
        };
      }
      if (reference === apiMock.vpmAliasPublications.commitPublicationForService) {
        return { status: 'PUBLISHED' };
      }
      throw new Error(`Unexpected mutation ${String(reference)}`);
    });
    const publish = mock(async (input: { body: Uint8Array; sha256: string }) => ({
      ...artifactReference({
        bootstrapVersion: '1.0.2',
        publicationId: '00000000-0000-4000-8000-000000000213',
        sha256: input.sha256,
      }),
      bucketName: 'metadata-current-epoch',
      byteSize: input.body.byteLength,
    }));

    const response = await createRoutes('creator-auth', {
      aliasArtifactStore: {
        bucketName: 'metadata-current-epoch',
        publish,
        readExact: mock(async () => new Uint8Array()),
      },
    }).manageCreatorLink(creatorMutationRequest('POST'), 'com.yucp.jammr');

    expect(response.status).toBe(200);
    expect(presentationUpdateInput).toMatchObject({
      artifactBucketName: 'metadata-current-epoch',
      packageId: 'com.yucp.jammr',
    });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('publishes a new immutable bootstrap when the artifact base URL changes', async () => {
    const previousPresentation = {
      artifactBaseUrl: 'https://retired-vpm.test',
      artifactBucketName: 'metadata',
      authorName: 'Mapache',
      channel: 'stable',
      description: 'Adds JAMMR after purchase verification.',
      media: [],
      minImporterVersion: '0.1.36',
      packageId: 'com.yucp.jammr',
      packageName: 'JAMMR',
      presentationFingerprintSha256: 'e'.repeat(64),
      unityVersion: '2022.3',
    };
    const currentPresentation = {
      ...previousPresentation,
      artifactBaseUrl: 'https://mapache.private.yucp.club',
      presentationFingerprintSha256: 'f'.repeat(64),
    };
    let presentationUpdated = false;
    let presentationUpdateInput: Record<string, unknown> | undefined;
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.getByPackageIdForAuthUser) return product();
      if (reference === apiMock.vpmAliasPublications.getPresentationForService) {
        return presentationUpdated ? currentPresentation : previousPresentation;
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });
    convexMutationMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.creatorVpmLinks.ensureActive) return link();
      if (reference === apiMock.vpmAliasPublications.updatePresentationForCreator) {
        presentationUpdated = true;
        presentationUpdateInput = args as Record<string, unknown>;
        return {
          created: false,
          changed: true,
          packageId: 'com.yucp.jammr',
          channel: 'stable',
          presentationFingerprintSha256: 'f'.repeat(64),
          updatedAt: 2,
        };
      }
      if (reference === apiMock.vpmAliasPublications.reservePublicationForService) {
        return {
          bootstrapVersion: '1.0.3',
          channel: 'stable',
          created: false,
          packageId: 'com.yucp.jammr',
          presentationFingerprintSha256: 'f'.repeat(64),
          publicationId: '00000000-0000-4000-8000-000000000214',
          revision: 4,
          status: 'PUBLISHED',
        };
      }
      throw new Error(`Unexpected mutation ${String(reference)}`);
    });

    const response = await createRoutes('creator-auth').manageCreatorLink(
      creatorMutationRequest('POST'),
      'com.yucp.jammr'
    );

    expect(response.status).toBe(200);
    expect(presentationUpdateInput).toMatchObject({
      artifactBaseUrl: 'https://mapache.private.yucp.club',
      packageId: 'com.yucp.jammr',
    });
  });

  it('records publication failure and returns 503 without a dynamic fallback', async () => {
    const presentation = {
      artifactBaseUrl: 'https://mapache.private.yucp.club',
      artifactBucketName: 'metadata',
      authorName: 'Mapache',
      channel: 'stable',
      description: 'Adds JAMMR after purchase verification.',
      media: [],
      minImporterVersion: '0.1.36',
      packageId: 'com.yucp.jammr',
      packageName: 'JAMMR',
      presentationFingerprintSha256: 'f'.repeat(64),
      unityVersion: '2022.3',
    };
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.getByPackageIdForAuthUser) return product();
      if (reference === apiMock.vpmAliasPublications.getPresentationForService) return presentation;
      throw new Error(`Unexpected query ${String(reference)}`);
    });
    const failed = mock(async () => ({ failed: true }));
    const activateLink = mock(async () => link());
    convexMutationMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.creatorVpmLinks.ensureActive) return await activateLink();
      if (reference === apiMock.vpmAliasPublications.reservePublicationForService) {
        return {
          bootstrapVersion: '1.0.0',
          channel: 'stable',
          created: true,
          packageId: 'com.yucp.jammr',
          presentationFingerprintSha256: 'f'.repeat(64),
          publicationId: '00000000-0000-4000-8000-000000000202',
          revision: 1,
          status: 'PREPARING',
        };
      }
      if (reference === apiMock.vpmAliasPublications.markPublicationFailedForService) {
        return await failed();
      }
      throw new Error(`Unexpected mutation ${String(reference)}`);
    });

    const response = await createRoutes('creator-auth', {
      aliasArtifactStore: {
        bucketName: 'metadata',
        publish: mock(async () => {
          throw new Error('metadata storage unavailable');
        }),
        readExact: mock(async () => new Uint8Array()),
      },
    }).manageCreatorLink(creatorMutationRequest('POST'), 'com.yucp.jammr');

    expect(response.status).toBe(503);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(activateLink).not.toHaveBeenCalled();
  });

  it('revokes the creator link without deleting immutable publications', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.getByPackageIdForAuthUser) return product();
      throw new Error(`Unexpected query ${String(reference)}`);
    });
    convexMutationMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.creatorVpmLinks.revokeActive) return { revoked: true };
      throw new Error(`Unexpected mutation ${String(reference)}`);
    });

    const response = await createRoutes('creator-auth').manageCreatorLink(
      creatorMutationRequest('DELETE'),
      'com.yucp.jammr'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    expect(convexMutationMock.mock.calls.flat().join(' ')).not.toContain('vpmAliasPublications');
  });

  it('rejects malformed public link IDs before any Convex read', async () => {
    const response = await createRoutes(null).serveCreatorLinkIndex(
      new Request('https://vpm.test/api/vpm/access/retired/index.json'),
      'retired'
    );

    expect(response.status).toBe(410);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  it('returns 410 when a valid link has no published bootstrap', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.creatorVpmLinks.getActiveByLinkId) return link('N'.repeat(43));
      if (reference === apiMock.vpmAliasPublications.listPublishedForPackage) return [];
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes(null).serveCreatorLinkIndex(
      new Request(`https://mapache.private.yucp.club/api/vpm/access/${'N'.repeat(43)}/index.json`),
      'N'.repeat(43)
    );

    expect(response.status).toBe(410);
  });

  it('serves every immutable bootstrap revision under one package-scoped alias', async () => {
    const publications = [
      publishedAlias({
        bootstrapVersion: '1.0.0',
        publicationId: '00000000-0000-4000-8000-000000000101',
        publishedAt: 100,
      }),
      publishedAlias({
        bootstrapVersion: '1.0.1',
        publicationId: '00000000-0000-4000-8000-000000000102',
        publishedAt: 200,
      }),
    ];
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.creatorVpmLinks.getActiveByLinkId) return link();
      if (reference === apiMock.vpmAliasPublications.listPublishedForPackage) {
        return publications;
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes(null).serveCreatorLinkIndex(
      new Request(`https://mapache.private.yucp.club/api/vpm/access/${'L'.repeat(43)}/index.json`),
      'L'.repeat(43)
    );
    const body = (await response.json()) as {
      packages: Record<string, { versions: Record<string, { url: string }> }>;
    };
    const aliasPackageId = publications[0]?.aliasPackageId as string;

    expect(response.status).toBe(200);
    expect(Object.keys(body.packages[aliasPackageId]?.versions ?? {})).toEqual(['1.0.0', '1.0.1']);
    expect(Object.keys(body.packages)).toContain('com.yucp.importer');
    expect(convexQueryMock.mock.calls.flat().join(' ')).not.toContain(
      'packageVersions.resolvePublicBootstrapPresentation'
    );
    expect(JSON.stringify(body)).not.toContain('catalog_jammr');
  });

  it('binds a private repository index to the creator-owned request hostname', async () => {
    const publication = publishedAlias({
      bootstrapVersion: '1.0.0',
      publicationId: '00000000-0000-4000-8000-000000000109',
      publishedAt: 100,
    });
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.creatorVpmLinks.getActiveByLinkId) return link();
      if (reference === apiMock.vpmAliasPublications.listPublishedForPackage) {
        return [publication];
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes(null, {
      config: {
        privateVpmRootDomain: 'private.yucp.club',
      },
    }).serveCreatorLinkIndex(
      new Request(`https://mapache.private.yucp.club/api/vpm/access/${'L'.repeat(43)}/index.json`),
      'L'.repeat(43)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      url: `https://mapache.private.yucp.club/api/vpm/access/${'L'.repeat(43)}/index.json`,
    });
  });

  it('keeps a renamed private repository hostname as an alias of the canonical host', async () => {
    const publication = publishedAlias({
      bootstrapVersion: '1.0.0',
      publicationId: '00000000-0000-4000-8000-000000000111',
      publishedAt: 100,
    });
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.creatorVpmLinks.getActiveByLinkId) return link();
      if (reference === apiMock.creatorProfiles.resolveDeliveryNamespace) {
        return {
          authUserId: 'creator-auth',
          canonicalSlug: 'mapache',
          status: 'alias',
        };
      }
      if (reference === apiMock.vpmAliasPublications.listPublishedForPackage) {
        return [publication];
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes(null).serveCreatorLinkIndex(
      new Request(
        `https://creator-10705330.private.yucp.club/api/vpm/access/${'L'.repeat(43)}/index.json`
      ),
      'L'.repeat(43)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      url: `https://mapache.private.yucp.club/api/vpm/access/${'L'.repeat(43)}/index.json`,
    });
  });

  it('never serves a creator repository through the shared VPM origin', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.creatorVpmLinks.getActiveByLinkId) return link();
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes(null, {
      config: {
        privateVpmRootDomain: undefined,
      },
    }).serveCreatorLinkIndex(
      new Request(`https://vpm.test/api/vpm/access/${'L'.repeat(43)}/index.json`),
      'L'.repeat(43)
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain(`https://vpm.test/api/vpm/access/${'L'.repeat(43)}/index.json`);
  });

  it('accepts the Worker-authenticated original creator hostname at the API origin', async () => {
    const publication = publishedAlias({
      bootstrapVersion: '1.0.0',
      publicationId: '00000000-0000-4000-8000-000000000110',
      publishedAt: 100,
    });
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.creatorVpmLinks.getActiveByLinkId) return link();
      if (reference === apiMock.vpmAliasPublications.listPublishedForPackage) {
        return [publication];
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes(null, {
      config: {
        internalRpcSharedSecret: 'trusted-web-secret',
        privateVpmRootDomain: 'private.yucp.club',
      },
    }).serveCreatorLinkIndex(
      new Request(`https://api.test/api/vpm/access/${'L'.repeat(43)}/index.json`, {
        headers: {
          'X-Internal-Service': 'web',
          'X-Internal-Service-Secret': 'trusted-web-secret',
          'X-YUCP-Public-Host': 'mapache.private.yucp.club',
        },
      }),
      'L'.repeat(43)
    );

    expect(response.status).toBe(200);
  });

  it('rejects a private repository link requested through another creator hostname', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.creatorVpmLinks.getActiveByLinkId) return link();
      if (reference === apiMock.creatorProfiles.resolveDeliveryNamespace) return null;
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes(null, {
      config: {
        privateVpmRootDomain: 'private.yucp.club',
      },
    }).serveCreatorLinkIndex(
      new Request(
        `https://another-creator.private.yucp.club/api/vpm/access/${'L'.repeat(43)}/index.json`
      ),
      'L'.repeat(43)
    );

    expect(response.status).toBe(410);
    expect(convexQueryMock.mock.calls.flat().join(' ')).not.toContain(
      'vpmAliasPublications.listPublishedForPackage'
    );
  });

  it('merges only the importer from the public repository', async () => {
    const publication = publishedAlias({
      bootstrapVersion: '1.0.0',
      publicationId: '00000000-0000-4000-8000-000000000106',
      publishedAt: 100,
    });
    importerIndexFetchMock.mockResolvedValueOnce(
      Response.json({
        packages: {
          'com.example.unrelated': {
            versions: {
              '9.9.9': {
                name: 'com.example.unrelated',
                version: '9.9.9',
                url: 'https://packages.example.test/unrelated.zip',
              },
            },
          },
          'com.yucp.importer': {
            versions: {
              '0.1.36': {
                name: 'com.yucp.importer',
                displayName: 'YUCP Package Importer',
                version: '0.1.36',
                unity: '2022.3',
                description: 'YUCP package importer',
                author: {
                  name: 'YUCP Club',
                  url: 'https://vpm.yucp.club/',
                },
                zipSHA256: 'b8f611e191f4fc796c84c3a52f55f5c3b7e62acdf574962a0499aade61533380',
                url: 'https://packages.example.test/com.yucp.importer-0.1.36.zip',
              },
            },
          },
        },
      })
    );
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.creatorVpmLinks.getActiveByLinkId) return link();
      if (reference === apiMock.vpmAliasPublications.listPublishedForPackage) {
        return [publication];
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes(null).serveCreatorLinkIndex(
      new Request(`https://mapache.private.yucp.club/api/vpm/access/${'L'.repeat(43)}/index.json`),
      'L'.repeat(43)
    );
    const body = (await response.json()) as {
      packages: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(Object.keys(body.packages).sort()).toEqual(
      ['com.yucp.alias.0123456789abcdef0123456789abcdef', 'com.yucp.importer'].sort()
    );
  });

  it('validates a local importer against its injected release ledger', async () => {
    const publication = publishedAlias({
      bootstrapVersion: '1.0.0',
      publicationId: '00000000-0000-4000-8000-000000000107',
      publishedAt: 100,
    });
    importerIndexFetchMock.mockResolvedValueOnce(
      Response.json({
        packages: {
          'com.yucp.importer': {
            versions: {
              '0.1.54': {
                name: 'com.yucp.importer',
                displayName: 'YUCP Package Importer',
                version: '0.1.54',
                unity: '2022.3',
                description: 'YUCP package importer',
                author: {
                  name: 'YUCP Club',
                  url: 'https://vpm.yucp.club/',
                },
                zipSHA256: 'd'.repeat(64),
                url: 'http://127.0.0.1:3004/packages/com.yucp.importer-0.1.54.zip',
              },
            },
          },
        },
      })
    );
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.creatorVpmLinks.getActiveByLinkId) return link();
      if (reference === apiMock.vpmAliasPublications.listPublishedForPackage) {
        return [publication];
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes(null, {
      config: {
        publicImporterReleaseLedger: {
          releases: {
            '0.1.54': {
              sha256: 'd'.repeat(64),
            },
          },
          schemaVersion: 1,
        },
      } as never,
    }).serveCreatorLinkIndex(
      new Request(`https://mapache.private.yucp.club/api/vpm/access/${'L'.repeat(43)}/index.json`),
      'L'.repeat(43)
    );

    expect(response.status).toBe(200);
  });

  it('keeps the repository stable when storefront and edition state changes', async () => {
    const publication = publishedAlias({
      bootstrapVersion: '1.0.0',
      publicationId: '00000000-0000-4000-8000-000000000104',
      publishedAt: 100,
    });
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.creatorVpmLinks.getActiveByLinkId) return link();
      if (reference === apiMock.vpmAliasPublications.listPublishedForPackage) {
        return [publication];
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });
    const routes = createRoutes(null);

    const first = await routes.serveCreatorLinkIndex(
      new Request(`https://mapache.private.yucp.club/api/vpm/access/${'L'.repeat(43)}/index.json`),
      'L'.repeat(43)
    );
    const second = await routes.serveCreatorLinkIndex(
      new Request(`https://mapache.private.yucp.club/api/vpm/access/${'L'.repeat(43)}/index.json`),
      'L'.repeat(43)
    );

    expect(await second.json()).toEqual(await first.json());
    expect(convexQueryMock.mock.calls.flat().join(' ')).not.toContain('packageRegistry');
  });

  it('downloads the latest creator bootstrap from its exact provider version', async () => {
    const publication = publishedAlias({
      bootstrapVersion: '1.0.1',
      publicationId: '00000000-0000-4000-8000-000000000105',
      publishedAt: 200,
    });
    const bytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
    const readExact = mock(async () => bytes);
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.getByPackageIdForAuthUser) return product();
      if (reference === apiMock.vpmAliasPublications.getLatestPublishedForPackage) {
        return publication;
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const unauthorized = await createRoutes(null).downloadCreatorBootstrap(
      new Request('https://api.test/api/creator/packages/by-package/com.yucp.jammr/bootstrap'),
      'com.yucp.jammr'
    );
    const response = await createRoutes('creator-auth', {
      aliasArtifactStore: {
        bucketName: 'metadata',
        publish: mock(async () => publication.artifact),
        readExact,
      },
    }).downloadCreatorBootstrap(
      new Request('https://api.test/api/creator/packages/by-package/com.yucp.jammr/bootstrap'),
      'com.yucp.jammr'
    );

    expect(unauthorized.status).toBe(401);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(readExact).toHaveBeenCalledWith(publication.artifact);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="jammr-bootstrap-1.0.1.zip"'
    );
  });

  it('serves an alias artifact from its recorded exact provider version', async () => {
    const publication = publishedAlias({
      bootstrapVersion: '1.0.0',
      publicationId: '00000000-0000-4000-8000-000000000103',
      publishedAt: 100,
    });
    const body = Uint8Array.from({ length: publication.artifact.byteSize }, (_, index) => index);
    const readExact = mock(async () => body);
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.vpmAliasPublications.getPublishedByPublicationId) {
        return publication;
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes(null, {
      aliasArtifactStore: {
        bucketName: 'metadata',
        publish: mock(async () => publication.artifact),
        readExact,
      },
    }).serveAliasPublication(
      new Request(
        `https://vpm.test/api/vpm/alias-publications/${publication.publicationId}/${publication.bootstrapVersion}.zip`
      ),
      publication.publicationId,
      publication.bootstrapVersion
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    expect(readExact).toHaveBeenCalledWith(publication.artifact);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('does not read storage for an unknown publication or mismatched version', async () => {
    const publication = publishedAlias({
      bootstrapVersion: '1.0.0',
      publicationId: '00000000-0000-4000-8000-000000000106',
      publishedAt: 100,
    });
    const readExact = mock(async () => new Uint8Array());
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.vpmAliasPublications.getPublishedByPublicationId) {
        return publication;
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes(null, {
      aliasArtifactStore: {
        bucketName: 'metadata',
        publish: mock(async () => publication.artifact),
        readExact,
      },
    }).serveAliasPublication(
      new Request('https://vpm.test/api/vpm/alias-publications/id/9.9.9.zip'),
      publication.publicationId,
      '9.9.9'
    );

    expect(response.status).toBe(404);
    expect(readExact).not.toHaveBeenCalled();
  });
});
