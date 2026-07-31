import { describe, expect, it } from 'bun:test';
import type { ProtectedPackageFile } from '../catalog';
import {
  backfillCouplingLanes,
  type BackfillManifestFile,
  isPureWorkerLane,
} from './couplingLaneBackfill';

function pngHeader(width: number, height: number, options?: { interlaced?: boolean }): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8; // bit depth
  bytes[25] = 6; // RGBA
  bytes[26] = 0;
  bytes[27] = 0;
  bytes[28] = options?.interlaced ? 1 : 0;
  return bytes;
}

function protectedFile(
  normalizedPath: string,
  materializerType: string,
  couplingLane?: string
): ProtectedPackageFile {
  return {
    materializerType,
    normalizedPath,
    required: false,
    sourceSha256: 'a'.repeat(64),
    ...(couplingLane ? { couplingLane } : {}),
  } as ProtectedPackageFile;
}

function manifestFile(normalizedPath: string, bytes: number): BackfillManifestFile {
  return { bytes, chunks: [], normalizedPath, sha256: 'a'.repeat(64) };
}

describe('backfillCouplingLanes', () => {
  it('routes a small streamable PNG to the worker lane', async () => {
    const result = await backfillCouplingLanes({
      manifestFiles: [manifestFile('Assets/a.png', 1024)],
      protectedFiles: [protectedFile('Assets/a.png', 'png')],
      readHeader: async () => pngHeader(2048, 2048),
    });

    expect(result.protectedFiles[0]).toMatchObject({ couplingLane: 'worker' });
    expect(result.lanes).toEqual({ container: 0, worker: 1 });
    expect(result.changed).toBe(true);
  });

  it('keeps an oversized PNG on the container lane', async () => {
    const result = await backfillCouplingLanes({
      manifestFiles: [manifestFile('Assets/big.png', 1024)],
      protectedFiles: [protectedFile('Assets/big.png', 'png')],
      readHeader: async () => pngHeader(20000, 20000),
    });

    expect(result.protectedFiles[0]).toMatchObject({ couplingLane: 'container' });
  });

  it('applies the tighter fallback budget to a non-streamable PNG', async () => {
    const streamable = await backfillCouplingLanes({
      manifestFiles: [manifestFile('Assets/i.png', 1024)],
      protectedFiles: [protectedFile('Assets/i.png', 'png')],
      readHeader: async () => pngHeader(4096, 4096),
    });
    const interlaced = await backfillCouplingLanes({
      manifestFiles: [manifestFile('Assets/i.png', 1024)],
      protectedFiles: [protectedFile('Assets/i.png', 'png')],
      readHeader: async () => pngHeader(4096, 4096, { interlaced: true }),
    });

    expect(streamable.protectedFiles[0]).toMatchObject({ couplingLane: 'worker' });
    expect(interlaced.protectedFiles[0]).toMatchObject({ couplingLane: 'container' });
  });

  it('resolves FBX and zip from manifest bytes without reading the file', async () => {
    let reads = 0;
    const result = await backfillCouplingLanes({
      manifestFiles: [
        manifestFile('Assets/small.fbx', 8 * 1024 * 1024),
        manifestFile('Assets/big.fbx', 64 * 1024 * 1024),
        manifestFile('Assets/nested.zip', 1024),
      ],
      protectedFiles: [
        protectedFile('Assets/small.fbx', 'fbx'),
        protectedFile('Assets/big.fbx', 'fbx'),
        protectedFile('Assets/nested.zip', 'zip'),
      ],
      readHeader: async () => {
        reads += 1;
        return new Uint8Array(33);
      },
    });

    expect(reads).toBe(0);
    expect(result.protectedFiles.map((file) => (file as { couplingLane?: string }).couplingLane)).toEqual(
      ['worker', 'container', 'container']
    );
  });

  it('never overwrites a lane that ingest already stamped', async () => {
    const result = await backfillCouplingLanes({
      manifestFiles: [manifestFile('Assets/a.png', 1024)],
      protectedFiles: [protectedFile('Assets/a.png', 'png', 'container')],
      readHeader: async () => {
        throw new Error('must not read an already-stamped file');
      },
    });

    expect(result.protectedFiles[0]).toMatchObject({ couplingLane: 'container' });
    expect(result.changed).toBe(false);
  });

  it('falls back to the container lane when the header cannot be read', async () => {
    const result = await backfillCouplingLanes({
      manifestFiles: [manifestFile('Assets/a.png', 1024)],
      protectedFiles: [protectedFile('Assets/a.png', 'png')],
      readHeader: async () => {
        throw new Error('object missing');
      },
    });

    expect(result.protectedFiles[0]).toMatchObject({ couplingLane: 'container' });
  });

  it('leaves the lane absent when the manifest has no matching file', async () => {
    const result = await backfillCouplingLanes({
      manifestFiles: [],
      protectedFiles: [protectedFile('Assets/a.png', 'png')],
      readHeader: async () => pngHeader(2048, 2048),
    });

    expect(result.protectedFiles[0]).not.toHaveProperty('couplingLane');
    expect(result.changed).toBe(false);
  });

  it('preserves input order under concurrency', async () => {
    const count = 40;
    const files = Array.from({ length: count }, (_, index) =>
      protectedFile(`Assets/f${index}.png`, 'png')
    );
    const manifests = Array.from({ length: count }, (_, index) =>
      manifestFile(`Assets/f${index}.png`, 1024)
    );

    const result = await backfillCouplingLanes({
      manifestFiles: manifests,
      protectedFiles: files,
      readHeader: async (file) => {
        const index = Number(/f(\d+)\.png$/.exec(file.normalizedPath)?.[1] ?? '0');
        await new Promise((resolve) => setTimeout(resolve, (count - index) % 7));
        // Even indexes are worker-sized, odd indexes exceed every budget.
        return index % 2 === 0 ? pngHeader(1024, 1024) : pngHeader(20000, 20000);
      },
    });

    expect(result.protectedFiles.map((f) => f.normalizedPath)).toEqual(
      files.map((f) => f.normalizedPath)
    );
    expect(
      result.protectedFiles.map((f) => (f as { couplingLane?: string }).couplingLane)
    ).toEqual(files.map((_, index) => (index % 2 === 0 ? 'worker' : 'container')));
  });
});

describe('isPureWorkerLane', () => {
  it('matches the dispatch predicate', () => {
    expect(isPureWorkerLane([])).toBe(false);
    expect(isPureWorkerLane([protectedFile('a.png', 'png', 'worker')])).toBe(true);
    expect(
      isPureWorkerLane([
        protectedFile('a.png', 'png', 'worker'),
        protectedFile('b.zip', 'zip', 'container'),
      ])
    ).toBe(false);
    expect(isPureWorkerLane([protectedFile('a.png', 'png')])).toBe(false);
  });
});
