import { describe, expect, it } from 'bun:test';
import {
  ACTIVE_PROTECTION_POLICY_ID,
  classifyPackageFiles,
  isProtectionPolicyId,
  protectionMaterializationPolicy,
} from './protectionPolicy';

describe('protection policy materialization semantics', () => {
  it('recognizes only the active protection policy', () => {
    expect(isProtectionPolicyId(ACTIVE_PROTECTION_POLICY_ID)).toBe(true);
    expect(isProtectionPolicyId('common-only-v1')).toBe(false);
    expect(isProtectionPolicyId('supported-visual-assets-v1')).toBe(false);
    expect(() => protectionMaterializationPolicy('common-only-v1')).toThrow(
      'Unknown protection policy: common-only-v1'
    );
    expect(() => protectionMaterializationPolicy('supported-visual-assets-v1')).toThrow(
      'Unknown protection policy: supported-visual-assets-v1'
    );
  });

  it('uses best-effort server materialization for the active policy', () => {
    expect(protectionMaterializationPolicy(ACTIVE_PROTECTION_POLICY_ID)).toEqual({
      minimumCoupledFiles: 1,
      protectedFileRequirement: 'best-effort',
    });
  });

  it('protects supported files and keeps other files byte-exact', () => {
    const snapshot = classifyPackageFiles({
      files: [
        {
          bytes: 128,
          normalizedPath: 'Assets/Product/model.fbx',
          path: 'model.fbx',
          sha256: '11'.repeat(32),
        },
        {
          bytes: 128,
          normalizedPath: 'Assets/Product/texture.png',
          path: 'texture.png',
          sha256: '22'.repeat(32),
        },
        {
          bytes: 128,
          normalizedPath: 'Assets/Product/source.zip',
          path: 'source.zip',
          sha256: '33'.repeat(32),
        },
        {
          bytes: 128,
          normalizedPath: 'Assets/Product/readme.txt',
          path: 'readme.txt',
          sha256: '44'.repeat(32),
        },
      ],
      policyId: ACTIVE_PROTECTION_POLICY_ID,
    });

    expect(snapshot.files).toEqual([
      {
        bytes: 128,
        classification: 'protected',
        materializerType: 'fbx',
        normalizedPath: 'Assets/Product/model.fbx',
        path: 'model.fbx',
        sha256: '11'.repeat(32),
      },
      {
        bytes: 128,
        classification: 'protected',
        materializerType: 'png',
        normalizedPath: 'Assets/Product/texture.png',
        path: 'texture.png',
        sha256: '22'.repeat(32),
      },
      {
        bytes: 128,
        classification: 'protected',
        materializerType: 'zip',
        normalizedPath: 'Assets/Product/source.zip',
        path: 'source.zip',
        sha256: '33'.repeat(32),
      },
      {
        bytes: 128,
        classification: 'common',
        normalizedPath: 'Assets/Product/readme.txt',
        path: 'readme.txt',
        sha256: '44'.repeat(32),
      },
    ]);
    expect(snapshot.id).toBe(ACTIVE_PROTECTION_POLICY_ID);
  });
});
