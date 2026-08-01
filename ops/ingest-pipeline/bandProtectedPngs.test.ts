import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { encodeChunk, parsePng, unfilterScanlines } from '../storage-core/pngBanding';
import { bandProtectedPngs } from './ingestPipeline';

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const inflate = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(inflateSync(Buffer.from(bytes)));

function makePng(width: number, height: number, colorType = 6, bitDepth = 8): Uint8Array {
  const channels = colorType === 2 ? 3 : 4;
  const sample = bitDepth === 16 ? 2 : 1;
  const rowBytes = width * channels * sample;
  const filtered = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    filtered[y * (rowBytes + 1)] = y % 5;
    for (let i = 0; i < rowBytes; i += 1) {
      filtered[y * (rowBytes + 1) + 1 + i] = (y * 37 + i * 17 + (i & 3) * 61) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  return new Uint8Array([
    ...SIG,
    ...encodeChunk('IHDR', ihdr),
    ...encodeChunk('IDAT', new Uint8Array(deflateSync(Buffer.from(filtered)))),
    ...encodeChunk('IEND', new Uint8Array(0)),
  ]);
}

let root = '';
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'band-ingest-'));
});
afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

async function place(name: string, bytes: Uint8Array) {
  const file = path.join(root, name);
  await writeFile(file, bytes);
  return {
    bytes: bytes.byteLength,
    normalizedPath: `Assets/${name}`,
    path: file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

describe('banding protected PNGs at ingest', () => {
  it('rewrites a bandable PNG, restates its digest, and reports the band', async () => {
    const png = makePng(512, 512);
    const original = await place('albedo.png', png);
    const [banded] = await bandProtectedPngs([
      { ...original, classification: 'protected' as const, materializerType: 'png' as const },
    ]);

    const band = banded?.band;
    if (!band) {
      throw new Error('A 512x512 RGBA PNG must be bandable');
    }
    expect(band.rows % 8).toBe(0);
    expect(band.y0 % 8).toBe(0);
    expect(band.y0 + band.rows).toBeLessThanOrEqual(512);

    // The digest and byte count must describe what is now on disk, because the
    // CAS addresses the stored bytes by exactly these.
    const onDisk = new Uint8Array(await readFile(original.path));
    expect(banded?.sha256).toBe(createHash('sha256').update(onDisk).digest('hex'));
    expect(banded?.bytes).toBe(onDisk.byteLength);
    expect(banded?.sha256).not.toBe(original.sha256);

    // ...and it is the same picture.
    const before = parsePng(png);
    const after = parsePng(onDisk);
    expect(after.header).toEqual(before.header);
    expect(unfilterScanlines(after.header, inflate(after.idat))).toEqual(
      unfilterScanlines(before.header, inflate(before.idat))
    );
  });

  it('leaves alone everything that cannot be banded', async () => {
    const cases = [
      // Too small: the band would be the whole image.
      { file: await place('icon.png', makePng(64, 64)), why: 'tiny' },
      // Greyscale: the marked channel would be ambiguous coming back.
      { file: await place('mask.png', makePng(512, 512, 0)), why: 'greyscale' },
      // Not a PNG at all.
      { file: await place('model.fbx', Uint8Array.from([1, 2, 3, 4])), why: 'not a png' },
    ];
    for (const { file, why } of cases) {
      const [result] = await bandProtectedPngs([
        { ...file, classification: 'protected' as const, materializerType: 'png' as const },
      ]);
      expect(result?.band, why).toBeUndefined();
      expect(result?.sha256, why).toBe(file.sha256);
      expect(new Uint8Array(await readFile(file.path)).byteLength, why).toBe(file.bytes);
    }
  });

  it('does not touch common files or non-PNG protected files', async () => {
    const readme = await place('notes.txt', new TextEncoder().encode('hello'));
    const mesh = await place('mesh.fbx', makePng(512, 512));
    const results = await bandProtectedPngs([
      { ...readme, classification: 'common' as const },
      { ...mesh, classification: 'protected' as const, materializerType: 'fbx' as const },
    ]);
    for (const result of results) {
      expect(result.band).toBeUndefined();
    }
  });
});
