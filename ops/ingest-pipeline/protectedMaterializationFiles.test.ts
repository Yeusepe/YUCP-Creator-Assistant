import { describe, expect, it } from 'bun:test';
import type { DeliveryManifestFile } from '../storage-core/deliveryManifest';
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
  it('keeps strict v1 protected files required', () => {
    expect(
      protectedMaterializationFiles({
        files: [protectedFile],
        protectionPolicyId: 'supported-visual-assets-v1',
      })
    ).toEqual([
      {
        materializerType: 'png',
        normalizedPath: 'Assets/Textures/tiny.png',
        required: true,
        sourceSha256: '22'.repeat(32),
      },
    ]);
  });

  it('publishes v2 protected files as best-effort', () => {
    expect(
      protectedMaterializationFiles({
        files: [protectedFile],
        protectionPolicyId: 'supported-visual-assets-v2',
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
});
