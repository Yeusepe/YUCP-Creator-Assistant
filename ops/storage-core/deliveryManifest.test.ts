import { describe, expect, test } from 'bun:test';
import {
  createDeliveryManifest,
  DESYNC_STORAGE_FORMAT_VERSION,
  parseDeliveryManifest,
} from './deliveryManifest';
import { ACTIVE_PROTECTION_POLICY_ID } from './protectionPolicyId';

describe('logical tree delivery manifest', () => {
  test('binds sorted file recipes and active-content policy', () => {
    const manifest = createDeliveryManifest({
      activeContentDigest: '44'.repeat(32),
      activePolicyVersion: 'active-content-policy-v1',
      chunkAvgKib: 256,
      commonRoot: '55'.repeat(32),
      normalizationPolicyVersion: 'package-normalization-policy-v2',
      files: [
        {
          bytes: 4096,
          chunks: [{ id: '22'.repeat(32), sha256: '11'.repeat(32), size: 4096 }],
          classification: 'common',
          normalizedPath: 'Assets/Jammr/shader.shader',
          sha256: '11'.repeat(32),
        },
      ],
      packageId: 'com.yucp.example',
      protectedSourceRoot: '66'.repeat(32),
      protectionPolicyDigest: '77'.repeat(32),
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      releaseRoot: '33'.repeat(32),
      schemaVersion: 4,
      storageFormatVersion: DESYNC_STORAGE_FORMAT_VERSION,
      version: '1.2.3',
      versionId: 'version-1',
      vpmDependencies: {
        'com.example.runtime': '>=2.0.0',
      },
      vpmRepositories: {
        'Example Repository': 'https://packages.example.test/index.json',
      },
    });
    expect(manifest.bootstrapMedia).toEqual([]);

    expect(manifest.files[0]?.sha256).toBe('11'.repeat(32));
    expect(manifest.activeContentDigest).toBe('44'.repeat(32));
    expect(manifest.vpmDependencies).toEqual({
      'com.example.runtime': '>=2.0.0',
    });
    expect(manifest.vpmRepositories).toEqual({
      'Example Repository': 'https://packages.example.test/index.json',
    });
  });

  test('carries payload-less product-link bootstrap media', () => {
    const manifest = createDeliveryManifest({
      activeContentDigest: '44'.repeat(32),
      activePolicyVersion: 'active-content-policy-v1',
      bootstrapMedia: [
        {
          kind: 'product-link',
          label: 'Gumroad',
          ordinal: 0,
          url: 'https://creator.gumroad.com/l/jammr',
        },
      ],
      chunkAvgKib: 256,
      commonRoot: '55'.repeat(32),
      normalizationPolicyVersion: 'package-normalization-policy-v2',
      files: [
        {
          bytes: 4096,
          chunks: [{ id: '22'.repeat(32), sha256: '11'.repeat(32), size: 4096 }],
          classification: 'common',
          normalizedPath: 'Assets/Jammr/shader.shader',
          sha256: '11'.repeat(32),
        },
      ],
      packageId: 'com.yucp.example',
      protectedSourceRoot: '66'.repeat(32),
      protectionPolicyDigest: '77'.repeat(32),
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      releaseRoot: '33'.repeat(32),
      schemaVersion: 4,
      storageFormatVersion: DESYNC_STORAGE_FORMAT_VERSION,
      version: '1.2.3',
      versionId: 'version-1',
      vpmDependencies: {},
      vpmRepositories: {},
    });

    expect(manifest.bootstrapMedia).toEqual([
      {
        kind: 'product-link',
        label: 'Gumroad',
        ordinal: 0,
        url: 'https://creator.gumroad.com/l/jammr',
      },
    ]);
    expect(parseDeliveryManifest(JSON.parse(JSON.stringify(manifest))).bootstrapMedia).toEqual(
      manifest.bootstrapMedia
    );
  });

  test('rejects unsorted or escaping logical files', () => {
    expect(() =>
      parseDeliveryManifest({
        activeContentDigest: '44'.repeat(32),
        activePolicyVersion: 'active-content-policy-v1',
        chunkAvgKib: 256,
        commonRoot: '55'.repeat(32),
        normalizationPolicyVersion: 'package-normalization-policy-v2',
        files: [
          {
            bytes: 1,
            chunks: [{ id: '22'.repeat(32), sha256: '11'.repeat(32), size: 1 }],
            classification: 'common',
            normalizedPath: 'Packages/z/file.txt',
            sha256: '11'.repeat(32),
          },
          {
            bytes: 1,
            chunks: [{ id: '55'.repeat(32), sha256: '66'.repeat(32), size: 1 }],
            classification: 'common',
            normalizedPath: 'Assets/a.txt',
            sha256: '66'.repeat(32),
          },
        ],
        packageId: 'com.yucp.example',
        protectedSourceRoot: '66'.repeat(32),
        protectionPolicyDigest: '77'.repeat(32),
        protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
        releaseRoot: '33'.repeat(32),
        schemaVersion: 4,
        storageFormatVersion: DESYNC_STORAGE_FORMAT_VERSION,
        version: '1.2.3',
        versionId: 'version-1',
        vpmDependencies: {},
        vpmRepositories: {},
      })
    ).toThrow('sorted');

    expect(() =>
      parseDeliveryManifest({
        activeContentDigest: '44'.repeat(32),
        activePolicyVersion: 'active-content-policy-v1',
        chunkAvgKib: 256,
        commonRoot: '55'.repeat(32),
        normalizationPolicyVersion: 'package-normalization-policy-v2',
        files: [
          {
            bytes: 1,
            chunks: [{ id: '22'.repeat(32), sha256: '11'.repeat(32), size: 1 }],
            classification: 'common',
            normalizedPath: '../escape',
            sha256: '11'.repeat(32),
          },
        ],
        packageId: 'com.yucp.example',
        protectedSourceRoot: '66'.repeat(32),
        protectionPolicyDigest: '77'.repeat(32),
        protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
        releaseRoot: '33'.repeat(32),
        schemaVersion: 4,
        storageFormatVersion: DESYNC_STORAGE_FORMAT_VERSION,
        version: '1.2.3',
        versionId: 'version-1',
        vpmDependencies: {},
        vpmRepositories: {},
      })
    ).toThrow('normalizedPath');
  });

  test('represents an empty file as one exact empty chunk', () => {
    const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const manifest = createDeliveryManifest({
      activeContentDigest: '44'.repeat(32),
      activePolicyVersion: 'active-content-policy-v1',
      chunkAvgKib: 256,
      commonRoot: '55'.repeat(32),
      normalizationPolicyVersion: 'package-normalization-policy-v2',
      files: [
        {
          bytes: 0,
          chunks: [{ id: '22'.repeat(32), sha256: emptySha256, size: 0 }],
          classification: 'common',
          normalizedPath: 'Assets/Empty.asset',
          sha256: emptySha256,
        },
      ],
      packageId: 'com.yucp.example',
      protectedSourceRoot: '66'.repeat(32),
      protectionPolicyDigest: '77'.repeat(32),
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      releaseRoot: '33'.repeat(32),
      schemaVersion: 4,
      storageFormatVersion: DESYNC_STORAGE_FORMAT_VERSION,
      version: '1.2.3',
      versionId: 'version-1',
      vpmDependencies: {},
      vpmRepositories: {},
    });

    expect(manifest.files[0]?.chunks).toHaveLength(1);
  });

  test('rejects a removed protection policy', () => {
    expect(() =>
      parseDeliveryManifest({
        activeContentDigest: '44'.repeat(32),
        activePolicyVersion: 'active-content-policy-v1',
        chunkAvgKib: 256,
        commonRoot: '55'.repeat(32),
        files: [
          {
            bytes: 1,
            chunks: [{ id: '22'.repeat(32), sha256: '11'.repeat(32), size: 1 }],
            classification: 'common',
            normalizedPath: 'Assets/a.txt',
            sha256: '11'.repeat(32),
          },
        ],
        normalizationPolicyVersion: 'package-normalization-policy-v2',
        packageId: 'com.yucp.example',
        protectedSourceRoot: '66'.repeat(32),
        protectionPolicyDigest: '77'.repeat(32),
        protectionPolicyId: 'common-only-v1',
        releaseRoot: '33'.repeat(32),
        schemaVersion: 4,
        storageFormatVersion: DESYNC_STORAGE_FORMAT_VERSION,
        version: '1.2.3',
        versionId: 'version-1',
        vpmDependencies: {},
        vpmRepositories: {},
      })
    ).toThrow('unsupported protectionPolicyId');
  });
});
