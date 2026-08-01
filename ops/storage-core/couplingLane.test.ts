import { describe, expect, it } from 'bun:test';
import { zipSync } from 'fflate';
import {
  COUPLING_WORKER_MAX_FBX_BYTES,
  COUPLING_WORKER_MAX_PNG_DIMENSION,
  COUPLING_WORKER_MAX_ZIP_ENTRIES,
  COUPLING_WORKER_MAX_ZIP_TOTAL_BYTES,
  readPngCouplingMetadata,
  readZipCouplingMetadata,
  resolveCouplingLane,
  resolveJobCouplingLane,
} from './couplingLane';

function pngHeader(
  width: number,
  height: number,
  options?: { colorType?: number; interlaced?: boolean }
): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = options?.colorType ?? 6;
  bytes[28] = options?.interlaced ? 1 : 0;
  return bytes;
}

describe('readPngCouplingMetadata', () => {
  it('reads dimensions and streamability from an IHDR', () => {
    expect(readPngCouplingMetadata(pngHeader(1024, 768))).toEqual({
      height: 768,
      streamingSupported: true,
      width: 1024,
    });
  });

  it('marks interlaced and palette images as non-streamable', () => {
    expect(
      readPngCouplingMetadata(pngHeader(64, 64, { interlaced: true }))?.streamingSupported
    ).toBe(false);
    expect(readPngCouplingMetadata(pngHeader(64, 64, { colorType: 3 }))?.streamingSupported).toBe(
      false
    );
  });

  it('returns null for anything that is not a PNG header', () => {
    expect(readPngCouplingMetadata(new Uint8Array(10))).toBeNull();
    expect(
      readPngCouplingMetadata(new TextEncoder().encode('not a png at all!!!!!!!!!!!!'))
    ).toBeNull();
  });
});

describe('png coupling lane', () => {
  const laneFor = (width: number, height: number, streaming = true) =>
    resolveCouplingLane({
      bytes: 1024,
      materializerType: 'png',
      pngHeight: height,
      pngStreamingSupported: streaming,
      pngWidth: width,
    });

  it('promotes a streamable image inside the pixel budget', () => {
    expect(laneFor(4096, 4096)).toBe('worker');
  });

  it('holds back an image past the dimension budget', () => {
    expect(laneFor(COUPLING_WORKER_MAX_PNG_DIMENSION + 1, 8)).toBe('container');
  });

  it('applies the tighter whole-buffer budget to non-streamable images', () => {
    expect(laneFor(4096, 4096, false)).toBe('container');
    expect(laneFor(2048, 2048, false)).toBe('worker');
  });

  it('holds back an image with no measured dimensions', () => {
    expect(resolveCouplingLane({ bytes: 1024, materializerType: 'png' })).toBe('container');
  });
});

describe('fbx coupling lane', () => {
  it('promotes a model inside the byte budget and holds back one past it', () => {
    expect(
      resolveCouplingLane({ bytes: COUPLING_WORKER_MAX_FBX_BYTES, materializerType: 'fbx' })
    ).toBe('worker');
    expect(
      resolveCouplingLane({ bytes: COUPLING_WORKER_MAX_FBX_BYTES + 1, materializerType: 'fbx' })
    ).toBe('container');
  });
});

describe('zip coupling lane', () => {
  function zipArchive(sizes: number[]): Uint8Array {
    return zipSync(
      Object.fromEntries(sizes.map((size, index) => [`entry${index}.bin`, new Uint8Array(size)]))
    );
  }

  const laneFor = (archive: Uint8Array) => {
    const metadata = readZipCouplingMetadata(archive);
    return resolveCouplingLane({
      bytes: archive.byteLength,
      materializerType: 'zip',
      ...(metadata ? { zipEntries: metadata.entries, zipTotalBytes: metadata.totalBytes } : {}),
    });
  };

  it('reads entry count and expanded size from the central directory', () => {
    expect(readZipCouplingMetadata(zipArchive([1000, 2000]))).toEqual({
      entries: 2,
      totalBytes: 3000,
    });
  });

  it('promotes a small archive to the worker lane', () => {
    expect(laneFor(zipArchive([1024]))).toBe('worker');
  });

  it('holds back an archive that expands past the budget', () => {
    // Small on disk, large once expanded: a byte count alone would promote it.
    const archive = zipArchive([COUPLING_WORKER_MAX_ZIP_TOTAL_BYTES + 1]);
    expect(archive.byteLength).toBeLessThan(COUPLING_WORKER_MAX_ZIP_TOTAL_BYTES);
    expect(laneFor(archive)).toBe('container');
  });

  it('holds back an archive with too many entries', () => {
    expect(
      resolveCouplingLane({
        bytes: 1024,
        materializerType: 'zip',
        zipEntries: COUPLING_WORKER_MAX_ZIP_ENTRIES + 1,
        zipTotalBytes: 1024,
      })
    ).toBe('container');
  });

  it('holds back an archive whose directory cannot be read', () => {
    expect(readZipCouplingMetadata(new TextEncoder().encode('not a zip'))).toBeNull();
    expect(resolveCouplingLane({ bytes: 1024, materializerType: 'zip' })).toBe('container');
  });
});

describe('unknown materializer types', () => {
  it('never promotes a type the codec has no worker path for', () => {
    for (const materializerType of ['', 'gltf', 'unitypackage', 'exe']) {
      expect(resolveCouplingLane({ bytes: 1, materializerType })).toBe('container');
    }
  });
});

describe('job coupling lane', () => {
  const workerPng = (megapixels: number) => ({
    couplingLane: 'worker' as const,
    pixelHeight: 1_000,
    pixelWidth: megapixels * 1_000,
  });

  it('keeps a package on the worker lane whenever every file is worker-eligible', () => {
    expect(resolveJobCouplingLane([workerPng(1), workerPng(2)])).toBe('worker');
  });

  it('routes a large all-worker package to workers: size never picks the container', () => {
    // Workers only, by requirement. A job-size bound briefly rerouted packages
    // like this to the container lane, which does not band; this pins that it
    // cannot come back.
    const files = Array.from({ length: 124 }, () => workerPng(16));
    expect(resolveJobCouplingLane(files)).toBe('worker');
  });

  it('still holds back a job containing any container-lane file', () => {
    expect(resolveJobCouplingLane([workerPng(1), { couplingLane: 'container' }])).toBe('container');
  });

  it('treats an unstamped file as container', () => {
    expect(resolveJobCouplingLane([workerPng(1), {}])).toBe('container');
  });

  it('routes an empty protected-file list to the legacy path', () => {
    expect(resolveJobCouplingLane([])).toBe('container');
  });
});
