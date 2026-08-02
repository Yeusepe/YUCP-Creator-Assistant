import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

import { COUPLING_FBX_SOURCE_MAX_BYTES, createFbxCouplingPlan } from '../storage-core/couplingPlan';
import { encodeChunk } from '../storage-core/pngBanding';
import type { ClassifiedPackageFile } from '../storage-core/protectionPolicy';
import { ACTIVE_PROTECTION_POLICY_ID } from '../storage-core/protectionPolicyId';
import { bandProtectedPngs, protectedMaterializationFiles } from './ingestPipeline';

const SHA = '22'.repeat(32);

function png(width: number, height: number): Uint8Array {
  const rowBytes = width * 4;
  const filtered = new Uint8Array((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    for (let index = 0; index < rowBytes; index += 1) {
      filtered[row * (rowBytes + 1) + 1 + index] = (row * 31 + index * 17) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...encodeChunk('IHDR', ihdr),
    ...encodeChunk('IDAT', new Uint8Array(zlib.deflateSync(filtered))),
    ...encodeChunk('IEND', new Uint8Array()),
  ]);
}

describe('v5 protected materialization planning', () => {
  let scratch = '';

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'yucp-coupling-v5-'));
  });

  afterAll(async () => {
    await rm(scratch, { force: true, recursive: true });
  });

  async function fixture(
    name: string,
    bytes: Uint8Array,
    materializerType: 'fbx' | 'png' | 'zip'
  ): Promise<ClassifiedPackageFile> {
    const path = join(scratch, name);
    await writeFile(path, bytes);
    return {
      bytes: bytes.byteLength,
      classification: 'protected',
      materializerType,
      normalizedPath: `Assets/${name}`,
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  it('publishes every planned protected file as required', () => {
    const couplingPlan = createFbxCouplingPlan(8);
    expect(
      protectedMaterializationFiles({
        files: [
          {
            bytes: 8,
            chunks: [{ id: '11'.repeat(32), sha256: SHA, size: 8 }],
            classification: 'protected',
            couplingPlan,
            materializerType: 'fbx',
            normalizedPath: 'Assets/model.fbx',
            sha256: SHA,
          },
        ],
        protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      })
    ).toEqual([
      {
        couplingPlan,
        materializerType: 'fbx',
        normalizedPath: 'Assets/model.fbx',
        required: true,
        sourceSha256: SHA,
      },
    ]);
  });

  it('plans a bounded whole PNG when a useful band does not fit', async () => {
    const source = await fixture('tiny.png', png(64, 64), 'png');
    const [planned] = await bandProtectedPngs([source]);
    expect(planned?.couplingPlan?.strategy).toBe('png-whole-v1');
    expect(planned?.couplingPlan?.peakDynamicBytes).toBeLessThanOrEqual(72 * 1024 * 1024);
  });

  it('plans FBX inside the 8 MiB envelope', async () => {
    const planned = await bandProtectedPngs([
      {
        bytes: COUPLING_FBX_SOURCE_MAX_BYTES,
        classification: 'protected',
        materializerType: 'fbx',
        normalizedPath: 'Assets/model.fbx',
        path: join(scratch, 'not-read.fbx'),
        sha256: SHA,
      },
    ]);
    expect(planned[0]?.couplingPlan?.strategy).toBe('fbx-v1');
  });

  it('fails ingest preflight for unsupported ZIP and over-budget FBX', async () => {
    const zip = await fixture('nested.zip', Uint8Array.of(1, 2, 3), 'zip');
    await expect(bandProtectedPngs([zip])).rejects.toThrow('unsupported by v5');
    await expect(
      bandProtectedPngs([
        {
          bytes: COUPLING_FBX_SOURCE_MAX_BYTES + 1,
          classification: 'protected',
          materializerType: 'fbx',
          normalizedPath: 'Assets/large.fbx',
          path: join(scratch, 'not-read-large.fbx'),
          sha256: SHA,
        },
      ])
    ).rejects.toThrow('exceeds the v1 bound');
  });
});
