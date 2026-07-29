import { createHash } from 'node:crypto';
import {
  createApiActorBinding,
  createAuthUserApiActor,
  createServiceApiActor,
} from '@yucp/shared/apiActor';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex } from './testHelpers';
import { _testing } from './vpmAliasPublications';

process.env.CONVEX_API_SECRET = 'test-secret';
process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';

const PACKAGE_ID = 'com.yucp.publication-ledger';
const CREATOR_ID = 'creator-publication-ledger';

async function creatorActor(authUserId = CREATOR_ID) {
  return await createApiActorBinding(
    createAuthUserApiActor({ authUserId, source: 'session' }),
    process.env.INTERNAL_SERVICE_AUTH_SECRET as string
  );
}

async function repositoryActor() {
  return await createApiActorBinding(
    createServiceApiActor({
      service: 'vpm-repository',
      scopes: ['downloads:service'],
      now: Date.now(),
    }),
    process.env.INTERNAL_SERVICE_AUTH_SECRET as string
  );
}

async function seedOwnedPackage(
  t: ReturnType<typeof makeTestConvex>,
  input: { authUserId?: string; packageId?: string } = {}
) {
  const authUserId = input.authUserId ?? CREATOR_ID;
  const packageId = input.packageId ?? PACKAGE_ID;
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert('package_registry', {
      packageId,
      packageName: 'Publication Ledger',
      publisherId: `creator:${authUserId}`,
      yucpUserId: authUserId,
      status: 'active',
      registeredAt: now,
      updatedAt: now,
    });
  });
}

function presentationArgs(
  overrides: Partial<{
    artifactBucketName: string;
    authorName: string;
    description: string;
    media: Array<{
      bucketName: string;
      byteSize: number;
      contentType: 'image/png';
      kind: 'icon' | 'banner';
      localPath: string;
      objectKey: string;
      providerVersion: string;
      sha256: string;
    }>;
    packageName: string;
    tagline: string;
  }> = {}
) {
  return {
    apiSecret: 'test-secret',
    actor: undefined as never,
    authUserId: CREATOR_ID,
    packageId: PACKAGE_ID,
    channel: 'stable' as const,
    artifactBaseUrl: 'https://packages.example.test',
    artifactBucketName: 'metadata',
    artifactFormat: 'vpm-alias-zip-v1' as const,
    contractVersion: 1 as const,
    packageName: 'Publication Ledger',
    authorName: 'YUCP Studio',
    description: 'Installs Publication Ledger after purchase verification.',
    unityVersion: '2022.3',
    importerPackage: 'com.yucp.importer' as const,
    minImporterVersion: '0.1.36',
    media: [],
    ...overrides,
  };
}

function artifactCommitArgs(
  publication: { bootstrapVersion: string; publicationId: string },
  bucketName = 'metadata'
) {
  const repositoryManifestJson = JSON.stringify({
    name: 'com.yucp.alias.0123456789abcdef0123456789abcdef',
    displayName: 'Publication Ledger',
    version: publication.bootstrapVersion,
    url: `https://packages.example.test/api/vpm/alias-publications/${publication.publicationId}/${publication.bootstrapVersion}.zip`,
    zipSHA256: '11'.repeat(32),
  });
  return {
    apiSecret: 'test-secret',
    actor: undefined as never,
    publicationId: publication.publicationId,
    repositoryManifestJson,
    repositoryManifestSha256: createHash('sha256').update(repositoryManifestJson).digest('hex'),
    artifact: {
      bucketName,
      byteSize: 1234,
      contentType: 'application/zip' as const,
      objectKey: `indexes/vpm/aliases/${publication.publicationId}/${publication.bootstrapVersion}.zip`,
      providerVersion:
        bucketName === 'metadata' ? 'exact-version-1' : `exact-version-${bucketName}`,
      sha256: '11'.repeat(32),
    },
  };
}

describe('VPM alias publication ledger', () => {
  it('maps monotonically increasing revisions to Unity-safe semantic versions', () => {
    expect(_testing.revisionToVersion(1)).toBe('1.0.0');
    expect(_testing.revisionToVersion(2)).toBe('1.0.1');
    expect(_testing.revisionToVersion(1_000_001)).toBe('1.1.0');
    expect(_testing.revisionToVersion(1_000_000_000_001)).toBe('2.0.0');
  });

  it('reserves revision one and reuses the reservation for the same public presentation', async () => {
    const t = makeTestConvex();
    await seedOwnedPackage(t);
    const presentation = await t.mutation(
      api.vpmAliasPublications.seedPresentationIfMissingForCreator,
      {
        ...presentationArgs(),
        actor: await creatorActor(),
      }
    );
    const actor = await repositoryActor();

    const first = await t.mutation(api.vpmAliasPublications.reservePublicationForService, {
      apiSecret: 'test-secret',
      actor,
      packageId: PACKAGE_ID,
      channel: 'stable',
      presentationFingerprintSha256: presentation.presentationFingerprintSha256,
      publicationId: '00000000-0000-4000-8000-000000000001',
      publicationReason: 'link-activation',
    });
    const retry = await t.mutation(api.vpmAliasPublications.reservePublicationForService, {
      apiSecret: 'test-secret',
      actor,
      packageId: PACKAGE_ID,
      channel: 'stable',
      presentationFingerprintSha256: presentation.presentationFingerprintSha256,
      publicationId: '00000000-0000-4000-8000-000000000002',
      publicationReason: 'link-activation',
    });

    expect(first).toMatchObject({
      bootstrapVersion: '1.0.0',
      created: true,
      publicationId: '00000000-0000-4000-8000-000000000001',
      revision: 1,
      status: 'PREPARING',
    });
    expect(retry).toEqual({ ...first, created: false });
  });

  it('writes a presentation whose media includes payload-less product links', async () => {
    const t = makeTestConvex();
    await seedOwnedPackage(t);
    const presentation = await t.mutation(
      api.vpmAliasPublications.seedPresentationIfMissingForCreator,
      {
        ...presentationArgs({
          media: [
            {
              bucketName: 'metadata',
              byteSize: 54_041,
              contentType: 'image/png',
              kind: 'icon',
              localPath: 'Documentation~/YUCP/icon.png',
              objectKey: 'indexes/bootstrap-media/icon.png',
              providerVersion: 'exact-icon-1',
              sha256: '28'.repeat(32),
            },
            {
              kind: 'product-link',
              label: 'Gumroad',
              ordinal: 0,
              url: 'https://example.gumroad.com/l/product',
            },
          ] as never,
        }),
        actor: await creatorActor(),
      }
    );

    expect(presentation.presentationFingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    const stored = await t.query(api.vpmAliasPublications.getPresentationForService, {
      apiSecret: 'test-secret',
      actor: await repositoryActor(),
      packageId: PACKAGE_ID,
      channel: 'stable',
    });
    expect(stored?.media).toHaveLength(2);
    expect(stored?.media.map((entry) => entry.kind).sort()).toEqual(['icon', 'product-link']);
  });

  it('publishes exact immutable artifact metadata and keeps prior revisions', async () => {
    const t = makeTestConvex();
    await seedOwnedPackage(t);
    const actor = await repositoryActor();
    const firstPresentation = await t.mutation(
      api.vpmAliasPublications.seedPresentationIfMissingForCreator,
      {
        ...presentationArgs(),
        actor: await creatorActor(),
      }
    );
    const first = await t.mutation(api.vpmAliasPublications.reservePublicationForService, {
      apiSecret: 'test-secret',
      actor,
      packageId: PACKAGE_ID,
      channel: 'stable',
      presentationFingerprintSha256: firstPresentation.presentationFingerprintSha256,
      publicationId: '00000000-0000-4000-8000-000000000010',
      publicationReason: 'link-activation',
    });
    const committedFirst = await t.mutation(api.vpmAliasPublications.commitPublicationForService, {
      ...artifactCommitArgs(first),
      actor,
    });
    const changedPresentation = await t.mutation(
      api.vpmAliasPublications.updatePresentationForCreator,
      {
        ...presentationArgs({ packageName: 'Publication Ledger Plus' }),
        actor: await creatorActor(),
      }
    );
    const registrationName = await t.run(async (ctx) => {
      return (
        await ctx.db
          .query('package_registry')
          .withIndex('by_package_id', (q) => q.eq('packageId', PACKAGE_ID))
          .unique()
      )?.packageName;
    });
    const second = await t.mutation(api.vpmAliasPublications.reservePublicationForService, {
      apiSecret: 'test-secret',
      actor,
      packageId: PACKAGE_ID,
      channel: 'stable',
      presentationFingerprintSha256: changedPresentation.presentationFingerprintSha256,
      publicationId: '00000000-0000-4000-8000-000000000011',
      publicationReason: 'presentation-update',
    });
    const committedSecond = await t.mutation(api.vpmAliasPublications.commitPublicationForService, {
      ...artifactCommitArgs(second),
      actor,
    });
    const publications = await t.query(api.vpmAliasPublications.listPublishedForPackage, {
      apiSecret: 'test-secret',
      actor,
      packageId: PACKAGE_ID,
      channel: 'stable',
      artifactBucketName: 'metadata',
    });

    expect(committedFirst.status).toBe('PUBLISHED');
    expect(registrationName).toBe('Publication Ledger Plus');
    expect(committedSecond).toMatchObject({ bootstrapVersion: '1.0.1', status: 'PUBLISHED' });
    expect(publications.map((publication) => publication.bootstrapVersion)).toEqual([
      '1.0.0',
      '1.0.1',
    ]);
    expect(publications[0]?.artifact.providerVersion).toBe('exact-version-1');
  });

  it('makes an identical commit retry idempotent and rejects changed published bytes', async () => {
    const t = makeTestConvex();
    await seedOwnedPackage(t);
    const actor = await repositoryActor();
    const presentation = await t.mutation(
      api.vpmAliasPublications.seedPresentationIfMissingForCreator,
      {
        ...presentationArgs(),
        actor: await creatorActor(),
      }
    );
    const reserved = await t.mutation(api.vpmAliasPublications.reservePublicationForService, {
      apiSecret: 'test-secret',
      actor,
      packageId: PACKAGE_ID,
      channel: 'stable',
      presentationFingerprintSha256: presentation.presentationFingerprintSha256,
      publicationId: '00000000-0000-4000-8000-000000000020',
      publicationReason: 'link-activation',
    });
    const commit = { ...artifactCommitArgs(reserved), actor };

    const first = await t.mutation(api.vpmAliasPublications.commitPublicationForService, commit);
    const retry = await t.mutation(api.vpmAliasPublications.commitPublicationForService, commit);

    expect(retry).toEqual(first);
    await expect(
      t.mutation(api.vpmAliasPublications.commitPublicationForService, {
        ...commit,
        artifact: { ...commit.artifact, providerVersion: 'different-version' },
      })
    ).rejects.toThrow('Published VPM alias publication is immutable');
  });

  it('does not create bootstrap revisions for paid release history', async () => {
    const t = makeTestConvex();
    await seedOwnedPackage(t);
    const actor = await repositoryActor();
    const presentation = await t.mutation(
      api.vpmAliasPublications.seedPresentationIfMissingForCreator,
      {
        ...presentationArgs(),
        actor: await creatorActor(),
      }
    );
    const reserved = await t.mutation(api.vpmAliasPublications.reservePublicationForService, {
      apiSecret: 'test-secret',
      actor,
      packageId: PACKAGE_ID,
      channel: 'stable',
      presentationFingerprintSha256: presentation.presentationFingerprintSha256,
      publicationId: '00000000-0000-4000-8000-000000000030',
      publicationReason: 'link-activation',
    });
    await t.mutation(api.vpmAliasPublications.commitPublicationForService, {
      ...artifactCommitArgs(reserved),
      actor,
    });
    await t.run(async (ctx) => {
      for (let index = 0; index < 100; index += 1) {
        await ctx.db.insert('package_versions_ref', {
          packageId: PACKAGE_ID,
          version: `2.0.${index}`,
          versionId: crypto.randomUUID(),
          activeContentDigest: '33'.repeat(32),
          activePolicyVersion: 'active-content-policy-v1',
          bindingRoot: '44'.repeat(32),
          commonRoot: '55'.repeat(32),
          logicalBytes: 1,
          logicalFiles: 1,
          manifestSha256: '66'.repeat(32),
          protectedFiles: [],
          protectedSourceRoot: '77'.repeat(32),
          protectionPolicyDigest: '88'.repeat(32),
          protectionPolicyId: 'protection-policy-v1',
          releaseRoot: '99'.repeat(32),
          vpmDependencies: {},
          vpmRepositories: {},
          channel: 'stable',
          state: index === 99 ? 'READY' : 'SUPERSEDED',
          createdAt: index + 1,
        });
      }
    });

    const publications = await t.query(api.vpmAliasPublications.listPublishedForPackage, {
      apiSecret: 'test-secret',
      actor,
      packageId: PACKAGE_ID,
      channel: 'stable',
      artifactBucketName: 'metadata',
    });

    expect(publications).toHaveLength(1);
    expect(publications[0]?.bootstrapVersion).toBe('1.0.0');
  });

  it('does not publish a new revision when exact media storage moves without byte changes', async () => {
    const t = makeTestConvex();
    await seedOwnedPackage(t);
    const media = [
      {
        bucketName: 'metadata-a',
        byteSize: 128,
        contentType: 'image/png' as const,
        kind: 'icon' as const,
        localPath: 'Documentation~/YUCP/icon.png',
        objectKey: 'indexes/bootstrap-media/icon-a.png',
        providerVersion: 'version-a',
        sha256: 'aa'.repeat(32),
      },
    ];
    const first = await t.mutation(api.vpmAliasPublications.seedPresentationIfMissingForCreator, {
      ...presentationArgs({ media }),
      actor: await creatorActor(),
    });
    const moved = await t.mutation(api.vpmAliasPublications.updatePresentationForCreator, {
      ...presentationArgs({
        media: [
          {
            ...media[0],
            bucketName: 'metadata-b',
            objectKey: 'indexes/bootstrap-media/icon-b.png',
            providerVersion: 'version-b',
          },
        ],
      }),
      actor: await creatorActor(),
    });

    expect(moved.presentationFingerprintSha256).toBe(first.presentationFingerprintSha256);
  });

  it('publishes and lists aliases inside the selected artifact bucket', async () => {
    const t = makeTestConvex();
    await seedOwnedPackage(t);
    const actor = await repositoryActor();
    const firstPresentation = await t.mutation(
      api.vpmAliasPublications.seedPresentationIfMissingForCreator,
      {
        ...presentationArgs({ artifactBucketName: 'metadata-old' }),
        actor: await creatorActor(),
      }
    );
    const first = await t.mutation(api.vpmAliasPublications.reservePublicationForService, {
      apiSecret: 'test-secret',
      actor,
      packageId: PACKAGE_ID,
      channel: 'stable',
      presentationFingerprintSha256: firstPresentation.presentationFingerprintSha256,
      publicationId: '00000000-0000-4000-8000-000000000040',
      publicationReason: 'link-activation',
    });
    await t.mutation(api.vpmAliasPublications.commitPublicationForService, {
      ...artifactCommitArgs(first, 'metadata-old'),
      actor,
    });
    const currentPresentation = await t.mutation(
      api.vpmAliasPublications.updatePresentationForCreator,
      {
        ...presentationArgs({ artifactBucketName: 'metadata-current' }),
        actor: await creatorActor(),
      }
    );
    const current = await t.mutation(api.vpmAliasPublications.reservePublicationForService, {
      apiSecret: 'test-secret',
      actor,
      packageId: PACKAGE_ID,
      channel: 'stable',
      presentationFingerprintSha256: currentPresentation.presentationFingerprintSha256,
      publicationId: '00000000-0000-4000-8000-000000000041',
      publicationReason: 'migration',
    });
    await t.mutation(api.vpmAliasPublications.commitPublicationForService, {
      ...artifactCommitArgs(current, 'metadata-current'),
      actor,
    });

    const currentPublications = await t.query(api.vpmAliasPublications.listPublishedForPackage, {
      apiSecret: 'test-secret',
      actor,
      packageId: PACKAGE_ID,
      channel: 'stable',
      artifactBucketName: 'metadata-current',
    });
    const latestCurrent = await t.query(api.vpmAliasPublications.getLatestPublishedForPackage, {
      apiSecret: 'test-secret',
      actor,
      packageId: PACKAGE_ID,
      channel: 'stable',
      artifactBucketName: 'metadata-current',
    });

    expect(currentPresentation.presentationFingerprintSha256).not.toBe(
      firstPresentation.presentationFingerprintSha256
    );
    expect(currentPublications.map((publication) => publication.bootstrapVersion)).toEqual([
      '1.0.1',
    ]);
    expect(latestCurrent?.artifact.bucketName).toBe('metadata-current');
  });
});
