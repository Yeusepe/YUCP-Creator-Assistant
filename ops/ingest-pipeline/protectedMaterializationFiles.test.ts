import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COUPLING_WORKER_MAX_FBX_BYTES,
  COUPLING_WORKER_MAX_PNG_DIMENSION,
} from '../storage-core/couplingLane';
import type { DeliveryManifestFile } from '../storage-core/deliveryManifest';
import { ACTIVE_PROTECTION_POLICY_ID } from '../storage-core/protectionPolicyId';
import { protectedMaterializationFiles, resolveProtectedFileCoupling } from './ingestPipeline';

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

  it('carries the stamped coupling lane through to the published protected files', () => {
    expect(
      protectedMaterializationFiles({
        files: [{ ...protectedFile, couplingLane: 'worker', pixelHeight: 64, pixelWidth: 64 }],
        protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      })
    ).toEqual([
      {
        couplingLane: 'worker',
        materializerType: 'png',
        normalizedPath: 'Assets/Textures/tiny.png',
        required: false,
        sourceSha256: '22'.repeat(32),
      },
    ]);
  });
});

describe('protected file coupling lane', () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'yucp-coupling-lane-'));
  });

  afterAll(async () => {
    await rm(scratch, { force: true, recursive: true });
  });

  function pngHeader(width: number, height: number): Buffer {
    const bytes = Buffer.alloc(33);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'ascii');
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    bytes[24] = 8;
    bytes[25] = 6;
    return bytes;
  }

  async function fixture(name: string, body: Buffer): Promise<{ bytes: number; path: string }> {
    const path = join(scratch, name);
    await writeFile(path, body);
    return { bytes: body.byteLength, path };
  }

  it('routes a decodable png to the worker lane with its dimensions', async () => {
    const file = await fixture('small.png', pngHeader(64, 32));
    expect(await resolveProtectedFileCoupling({ ...file, materializerType: 'png' })).toEqual({
      couplingLane: 'worker',
      pixelHeight: 32,
      pixelWidth: 64,
    });
  });

  it('routes an oversized png to the container lane but keeps dimensions', async () => {
    const file = await fixture('large.png', pngHeader(64, 32));
    expect(
      await resolveProtectedFileCoupling(
        { ...file, materializerType: 'png' },
        {
          maxFbxBytes: COUPLING_WORKER_MAX_FBX_BYTES,
          maxPngFallbackPixels: 64 * 32 - 1,
          maxPngDimension: COUPLING_WORKER_MAX_PNG_DIMENSION,
          maxPngPixels: 64 * 32 - 1,
        }
      )
    ).toEqual({ couplingLane: 'container', pixelHeight: 32, pixelWidth: 64 });
  });

  it('routes a supplied large streamable png to the worker lane', async () => {
    const file = await fixture('large-streamable.png', pngHeader(14_104, 14_103));
    expect(await resolveProtectedFileCoupling({ ...file, materializerType: 'png' })).toEqual({
      couplingLane: 'worker',
      pixelHeight: 14_103,
      pixelWidth: 14_104,
    });
  });

  it('routes a png beyond the codec dimension cap to the container lane', async () => {
    const file = await fixture('too-wide.png', pngHeader(16_385, 1));
    expect(await resolveProtectedFileCoupling({ ...file, materializerType: 'png' })).toEqual({
      couplingLane: 'container',
      pixelHeight: 1,
      pixelWidth: 16_385,
    });
  });

  it('routes a malformed png to the container lane without dimensions', async () => {
    const header = pngHeader(64, 32);
    header.write('JUNK', 12, 'ascii');
    const file = await fixture('malformed.png', header);
    expect(await resolveProtectedFileCoupling({ ...file, materializerType: 'png' })).toEqual({
      couplingLane: 'container',
    });
  });

  it('routes fbx by byte size against the worker cap', async () => {
    const file = await fixture('model.fbx', Buffer.alloc(64, 1));
    expect(await resolveProtectedFileCoupling({ ...file, materializerType: 'fbx' })).toEqual({
      couplingLane: 'worker',
    });
    expect(
      await resolveProtectedFileCoupling(
        { ...file, materializerType: 'fbx' },
        {
          maxFbxBytes: 63,
          maxPngFallbackPixels: 4096 * 4096,
          maxPngDimension: COUPLING_WORKER_MAX_PNG_DIMENSION,
          maxPngPixels: 4096 * 4096,
        }
      )
    ).toEqual({ couplingLane: 'container' });
  });

  it('always routes zip to the container lane', async () => {
    const file = await fixture('nested.zip', Buffer.alloc(4, 1));
    expect(await resolveProtectedFileCoupling({ ...file, materializerType: 'zip' })).toEqual({
      couplingLane: 'container',
    });
  });
});
