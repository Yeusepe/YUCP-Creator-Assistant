import { describe, expect, test } from 'bun:test';
import {
  createDeliveryManifest,
  DESYNC_STORAGE_FORMAT_VERSION,
  parseDeliveryManifest,
} from './deliveryManifest';
import { ACTIVE_PROTECTION_POLICY_ID } from './protectionPolicyId';

function couplingManifest(file: Record<string, unknown>) {
  return {
    activeContentDigest: '44'.repeat(32),
    activePolicyVersion: 'active-content-policy-v1',
    chunkAvgKib: 256,
    commonRoot: '55'.repeat(32),
    files: [file],
    normalizationPolicyVersion: 'package-normalization-policy-v2',
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
  };
}

describe('logical tree delivery manifest', () => {
  const BAND = {
    length: 3219,
    offset: 4069,
    prefixAdler: 576628372,
    rows: 112,
    suffixAdler: 1828093411,
    suffixFilteredLength: 491760,
    y0: 160,
  };

  function protectedFileWithBand(band: unknown) {
    return {
      band,
      bytes: 4096,
      chunks: [{ id: '22'.repeat(32), sha256: '11'.repeat(32), size: 4096 }],
      classification: 'protected',
      materializerType: 'png',
      normalizedPath: 'Assets/Jammr/albedo.png',
      pixelHeight: 512,
      pixelWidth: 512,
      sha256: '11'.repeat(32),
    };
  }

  test('carries a band index through create and parse', () => {
    const manifest = createDeliveryManifest(
      couplingManifest(protectedFileWithBand(BAND) as never) as never
    );
    // The materializer reads this off the wire, so it has to survive the trip.
    expect(parseDeliveryManifest(JSON.parse(JSON.stringify(manifest))).files[0]?.band).toEqual(
      BAND
    );
  });

  test('rejects a band that is unusable or on the wrong kind of file', () => {
    for (const band of [
      { ...BAND, rows: 111 }, // not whole 8-row blocks
      { ...BAND, y0: 3 }, // not block aligned
      { ...BAND, length: 0 }, // nothing to replace
      { ...BAND, offset: -1 }, // negative
      { ...BAND, prefixAdler: 1.5 }, // not an integer
      { rows: 8 }, // incomplete
      'nope',
    ]) {
      expect(() =>
        parseDeliveryManifest(
          JSON.parse(JSON.stringify(couplingManifest(protectedFileWithBand(band) as never)))
        )
      ).toThrow();
    }
    // A band on a common file is a manifest that contradicts itself.
    expect(() =>
      parseDeliveryManifest(
        JSON.parse(
          JSON.stringify(
            couplingManifest({
              band: BAND,
              bytes: 4096,
              chunks: [{ id: '22'.repeat(32), sha256: '11'.repeat(32), size: 4096 }],
              classification: 'common',
              normalizedPath: 'Assets/Jammr/shader.shader',
              sha256: '11'.repeat(32),
            } as never)
          )
        )
      )
    ).toThrow();
  });

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

  test('round-trips coupling lane and pixel dimensions on protected files', () => {
    const manifest = parseDeliveryManifest(
      couplingManifest({
        bytes: 4096,
        chunks: [{ id: '22'.repeat(32), sha256: '11'.repeat(32), size: 4096 }],
        classification: 'protected',
        couplingLane: 'worker',
        materializerType: 'png',
        normalizedPath: 'Assets/Jammr/texture.png',
        pixelHeight: 32,
        pixelWidth: 64,
        sha256: '11'.repeat(32),
      })
    );
    expect(manifest.files[0]).toMatchObject({
      couplingLane: 'worker',
      pixelHeight: 32,
      pixelWidth: 64,
    });
    expect(parseDeliveryManifest(JSON.parse(JSON.stringify(manifest))).files).toEqual(
      manifest.files
    );
  });

  test('keeps legacy files without coupling fields valid', () => {
    const manifest = parseDeliveryManifest(
      couplingManifest({
        bytes: 4096,
        chunks: [{ id: '22'.repeat(32), sha256: '11'.repeat(32), size: 4096 }],
        classification: 'protected',
        materializerType: 'fbx',
        normalizedPath: 'Assets/Jammr/model.fbx',
        sha256: '11'.repeat(32),
      })
    );
    expect(manifest.files[0]?.couplingLane).toBeUndefined();
    expect(manifest.files[0]?.pixelWidth).toBeUndefined();
  });

  test('rejects invalid coupling fields', () => {
    const protectedFile = {
      bytes: 4096,
      chunks: [{ id: '22'.repeat(32), sha256: '11'.repeat(32), size: 4096 }],
      classification: 'protected',
      materializerType: 'png',
      normalizedPath: 'Assets/Jammr/texture.png',
      sha256: '11'.repeat(32),
    };
    expect(() =>
      parseDeliveryManifest(
        couplingManifest({
          ...protectedFile,
          classification: 'common',
          couplingLane: 'worker',
          materializerType: undefined,
        })
      )
    ).toThrow('couplingLane');
    expect(() =>
      parseDeliveryManifest(couplingManifest({ ...protectedFile, couplingLane: 'gpu' }))
    ).toThrow('couplingLane');
    expect(() =>
      parseDeliveryManifest(couplingManifest({ ...protectedFile, pixelHeight: 32, pixelWidth: 0 }))
    ).toThrow('pixelWidth');
    expect(() =>
      parseDeliveryManifest(
        couplingManifest({ ...protectedFile, pixelHeight: 1.5, pixelWidth: 32 })
      )
    ).toThrow('pixelHeight');
    expect(() =>
      parseDeliveryManifest(couplingManifest({ ...protectedFile, pixelWidth: 32 }))
    ).toThrow('unpaired pixel dimensions');
    expect(() =>
      parseDeliveryManifest(
        couplingManifest({
          ...protectedFile,
          classification: 'common',
          materializerType: undefined,
          pixelHeight: 32,
          pixelWidth: 32,
        })
      )
    ).toThrow('pixelWidth');
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
