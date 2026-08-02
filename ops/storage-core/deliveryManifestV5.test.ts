import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  type CouplingPlan,
  createFbxCouplingPlan,
  createPngBandCouplingPlan,
} from './couplingPlan';
import {
  createDeliveryManifest,
  DESYNC_STORAGE_FORMAT_VERSION,
  deliveryManifestObjectId,
  LOGICAL_TREE_MANIFEST_SCHEMA_VERSION,
  parseDeliveryManifest,
} from './deliveryManifest';
import { ACTIVE_PROTECTION_POLICY_ID } from './protectionPolicyId';

const SHA = '11'.repeat(32);

function manifest(file: Record<string, unknown>) {
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
    schemaVersion: 5,
    storageFormatVersion: DESYNC_STORAGE_FORMAT_VERSION,
    version: '1.2.3',
    versionId: 'version-1',
    vpmDependencies: {},
    vpmRepositories: {},
  };
}

function protectedFile(couplingPlan: CouplingPlan, materializerType = 'png') {
  return {
    bytes: 4096,
    chunks: [{ id: '22'.repeat(32), sha256: SHA, size: 4096 }],
    classification: 'protected' as const,
    couplingPlan,
    materializerType,
    normalizedPath: `Assets/Jammr/albedo.${materializerType}`,
    sha256: SHA,
  };
}

describe('delivery manifest v5 cutover', () => {
  it('uses only the v5 object name and schema', () => {
    expect(LOGICAL_TREE_MANIFEST_SCHEMA_VERSION).toBe(5);
    expect(deliveryManifestObjectId('version-1')).toBe('version-1.logical-tree-v5.json');
  });

  it('rejects v4 without a compatibility path', () => {
    expect(() => parseDeliveryManifest({ schemaVersion: 4 })).toThrow('schemaVersion');
  });

  it('round-trips the strict discriminated coupling plan golden', () => {
    const couplingPlan = createPngBandCouplingPlan({
      band: {
        idatPrefixCrc32: 123,
        idatSuffixCrc32: 456,
        idatSuffixLength: 789,
        length: 3219,
        offset: 4069,
        prefixAdler: 576628372,
        rows: 112,
        suffixAdler: 1828093411,
        suffixFilteredLength: 491760,
        y0: 160,
      },
      bitDepth: 8,
      colorType: 6,
      fileBytes: 4096,
      height: 512,
      rowBytes: 2048,
      width: 512,
    });
    const created = createDeliveryManifest(manifest(protectedFile(couplingPlan)) as never);
    expect(parseDeliveryManifest(JSON.parse(JSON.stringify(created))).files[0]).toEqual(
      protectedFile(couplingPlan)
    );
  });

  it('accepts the cross-repository v5 golden fixture', () => {
    const golden = JSON.parse(
      readFileSync(new URL('./testdata/delivery-manifest-v5.golden.json', import.meta.url), 'utf8')
    );
    expect(parseDeliveryManifest(golden).files[0]).toEqual(golden.files[0]);
  });

  it('rejects plan mismatch, optional legacy fields, and unsupported ZIP', () => {
    const fbx = createFbxCouplingPlan(4096);
    expect(() =>
      parseDeliveryManifest(manifest(protectedFile({ ...fbx, peakDynamicBytes: 1 }, 'fbx')))
    ).toThrow('couplingPlan');
    expect(() =>
      parseDeliveryManifest(manifest({ ...protectedFile(fbx, 'fbx'), couplingLane: 'worker' }))
    ).toThrow('invalid fields');
    expect(() => parseDeliveryManifest(manifest(protectedFile(fbx, 'zip')))).toThrow();
  });

  it('requires a plan for every protected file and forbids one on common files', () => {
    const {
      couplingPlan: _plan,
      materializerType: _type,
      ...missing
    } = protectedFile(createFbxCouplingPlan(4096), 'fbx');
    expect(() => parseDeliveryManifest(manifest(missing))).toThrow('invalid fields');
    expect(() =>
      parseDeliveryManifest(
        manifest({
          bytes: 4096,
          chunks: [{ id: '22'.repeat(32), sha256: SHA, size: 4096 }],
          classification: 'common',
          couplingPlan: createFbxCouplingPlan(4096),
          normalizedPath: 'Assets/Jammr/file.txt',
          sha256: SHA,
        })
      )
    ).toThrow('invalid fields');
  });
});
