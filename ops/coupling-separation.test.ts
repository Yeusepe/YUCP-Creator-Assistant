import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const workspaceRoot = path.resolve(import.meta.dir, '..');

const forbiddenPublicImplementationPaths = [
  'apps/api/src/lib/couplingRuntimeConfig.ts',
  'apps/api/src/routes/couplingRuntimeGateway.ts',
  'convex/couplingRuntime.ts',
  'convex/couplingRuntimeUpload.ts',
  'convex/lib/couplingRuntimeConfig.ts',
  'convex/lib/couplingRuntimeEnvelope.ts',
  'convex/lib/couplingRuntimePackageConfig.ts',
  'convex/lib/protectedAssetKeyCrypto.ts',
  'convex/lib/protectedAssetUnlockMode.ts',
  'convex/lib/protectedMaterializationGrant.ts',
  'convex/releaseArtifacts.ts',
  'ops/storage-core/linuxCodecWorker.py',
  'ops/storage-core/linuxMaterialization.realtest.ts',
  'ops/publish-coupling-runtime-package.ts',
  'ops/publish-coupling-runtime.ts',
] as const;

const forbiddenPublicSourceFragments = [
  '/v1/licenses/coupling-job',
  '/v1/licenses/coupling-runtime',
  '/v1/licenses/unlock-protected',
  'assembleCouplingJob',
  'contentKeyBase64',
  'deriveCouplingRuntimeEnvelopeKeyBytes',
  'issueCouplingJob',
  'signCouplingRuntimeJwt',
  'signProtectedUnlockJwt',
  'wrappedContentKey',
] as const;

const forbiddenPublicMaterializationFragments = [
  '/envelopes/create',
  '@hpke/core',
  'MATERIALIZATION_MASTER_EPOCH_KEYS',
  'createCipheriv',
  'createHmac',
  'hkdfSync',
  'keyEnvelope',
  'masterEpochKeys',
  'materializationDerivationInfo',
  'materializationKeyBundle',
  'recipientPublicKey',
] as const;

const forbiddenImporterRuntimePaths = [
  'Editor/PackageManager/Core/AliasMetadataEnrichmentService.cs',
  'Editor/PackageManager/Core/AliasPackageAutoInstaller.cs',
  'Editor/PackageManager/Core/AuthorizedVpmPackageInstaller.cs',
  'Editor/PackageManager/Core/CouplingImportGuard.cs',
  'Editor/PackageManager/Core/CouplingRuntimeBootstrapService.cs',
  'Editor/PackageManager/Core/CouplingRuntimeService.cs',
  'Editor/PackageManager/Core/CouplingRuntimeShimService.cs',
  'Editor/PackageManager/Core/ProtectedPayloadComShimBridge.cs',
  'Editor/PackageManager/Core/UpdateDeliveryService.cs',
] as const;

const forbiddenImporterSourceFragments = [
  '/install-plan',
  'alias-install-plan-v1',
  'AuthorizedVpmPackageInstaller',
  'contentKey',
  'couplingRuntime',
  'downloadAuthorizationUrl',
  'protectedSource',
  'wrappedContentKey',
] as const;

describe('coupling repository separation', () => {
  test('keeps proprietary materialization implementation outside CreatorAssistant', () => {
    expect(
      forbiddenPublicImplementationPaths.filter((relativePath) =>
        existsSync(path.join(workspaceRoot, relativePath))
      )
    ).toEqual([]);

    const productionSources = ['apps/api/src', 'convex'].flatMap((sourceRoot) => {
      const absoluteRoot = path.join(workspaceRoot, sourceRoot);
      return [...new Bun.Glob('**/*.ts').scanSync({ cwd: absoluteRoot, onlyFiles: true })]
        .filter(
          (relativePath) =>
            !relativePath.endsWith('.test.ts') &&
            !relativePath.endsWith('.realtest.ts') &&
            !relativePath.startsWith('_generated/')
        )
        .map((relativePath) => ({
          relativePath: path.join(sourceRoot, relativePath),
          source: readFileSync(path.join(absoluteRoot, relativePath), 'utf8'),
        }));
    });

    expect(
      productionSources.flatMap(({ relativePath, source }) =>
        forbiddenPublicSourceFragments
          .filter((fragment) => source.includes(fragment))
          .map((fragment) => `${relativePath}: ${fragment}`)
      )
    ).toEqual([]);

    const materializationSources = [
      ...new Bun.Glob('**/*.ts').scanSync({
        cwd: path.join(workspaceRoot, 'ops/materialization'),
        onlyFiles: true,
      }),
    ]
      .filter(
        (relativePath) =>
          !relativePath.endsWith('.test.ts') &&
          !relativePath.endsWith('.realtest.ts')
      )
      .map((relativePath) => ({
        relativePath: path.join('ops/materialization', relativePath),
        source: readFileSync(
          path.join(
            workspaceRoot,
            'ops/materialization',
            relativePath
          ),
          'utf8'
        ),
      }));

    expect(
      materializationSources.flatMap(({ relativePath, source }) =>
        forbiddenPublicMaterializationFragments
          .filter((fragment) => source.includes(fragment))
          .map((fragment) => `${relativePath}: ${fragment}`)
      )
    ).toEqual([]);
  });

  test('keeps coupling execution outside the Unity importer', () => {
    const importerRoot = path.resolve(
      workspaceRoot,
      '..',
      '..',
      '..',
      'Unity',
      'Components',
      'YUCP-Components',
      'Packages',
      'com.yucp.importer'
    );

    if (!existsSync(importerRoot)) {
      return;
    }

    expect(
      forbiddenImporterRuntimePaths.filter((relativePath) =>
        existsSync(path.join(importerRoot, relativePath))
      )
    ).toEqual([]);

    const productionSources = [
      ...new Bun.Glob('Editor/**/*.cs').scanSync({ cwd: importerRoot, onlyFiles: true }),
      ...new Bun.Glob('Runtime/**/*.cs').scanSync({ cwd: importerRoot, onlyFiles: true }),
    ].map((relativePath) => ({
      relativePath,
      source: readFileSync(path.join(importerRoot, relativePath), 'utf8'),
    }));

    expect(
      productionSources.flatMap(({ relativePath, source }) =>
        forbiddenImporterSourceFragments
          .filter((fragment) => source.includes(fragment))
          .map((fragment) => `${relativePath}: ${fragment}`)
      )
    ).toEqual([]);
  });
});
