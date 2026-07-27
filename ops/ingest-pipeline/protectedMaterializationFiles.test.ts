import { describe, expect, it } from 'bun:test';
import type { DeliveryManifestFile } from '../storage-core/deliveryManifest';
import { ACTIVE_PROTECTION_POLICY_ID } from '../storage-core/protectionPolicyId';
import { protectedMaterializationFiles } from './ingestPipeline';

const protectedFile: DeliveryManifestFile = {
  bytes: 8,
  chunks: [{ id: '11'.repeat(32), sha256: '11'.repeat(32), size: 8 }],
  classification: 'protected',
  materializerType: 'png',
  normalizedPath: 'Assets/Textures/tiny.png',
  sha256: '22'.repeat(32),
};

describe('protected materialization publication', () => {
  it('publishes active-policy protected files as best-effort', () => {
    expect(
      protectedMaterializationFiles({
        files: [protectedFile],
        protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      })
    ).toEqual([
      {
        materializerType: 'png',
        normalizedPath: 'Assets/Textures/tiny.png',
        required: false,
        sourceSha256: '22'.repeat(32),
      },
    ]);
  });

  it('rejects removed protection policies', () => {
    expect(() =>
      protectedMaterializationFiles({
        files: [protectedFile],
        protectionPolicyId: 'supported-visual-assets-v1',
      })
    ).toThrow('Unknown protection policy: supported-visual-assets-v1');
  });
});
