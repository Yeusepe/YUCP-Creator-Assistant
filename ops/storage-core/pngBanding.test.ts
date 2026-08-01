import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { deflateSync, inflateRawSync, inflateSync } from 'node:zlib';
import {
  encodeChunk,
  normalizePngForBanding,
  PngBandError,
  parsePng,
  placeBand,
  planBand,
  unfilterScanlines,
} from './pngBanding';

const SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const inflate = (bytes: Uint8Array): Uint8Array => new Uint8Array(inflateSync(Buffer.from(bytes)));

/**
 * The shared lockstep fixture. ca-coupling/src/pngBandSplice.test.ts builds the
 * same image with the same function and asserts the same numbers below; if
 * either repo's copy of the band format drifts, both suites go red together.
 */
export function bandingFixture(width: number, height: number, colorType: number, bitDepth: number) {
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

function rasterOf(png: Uint8Array): Uint8Array {
  const parsed = parsePng(png);
  return unfilterScanlines(parsed.header, inflate(parsed.idat));
}

describe('publish-time banding', () => {
  it('re-encodes losslessly: same pixels, same depth, same colour type', async () => {
    for (const [colorType, bitDepth] of [
      [2, 8],
      [2, 16],
      [6, 8],
      [6, 16],
    ] as const) {
      const png = bandingFixture(256, 256, colorType, bitDepth);
      const header = parsePng(png).header;
      const planned = planBand(header, { blocks: 864, minFraction: 0.05 });
      const band = placeBand(header, planned as { rows: number; y0: number }, Uint8Array.from([1]));
      const banded = await normalizePngForBanding({ band, level: 6, png });

      expect(parsePng(banded.base).header).toEqual(header);
      expect(rasterOf(banded.base)).toEqual(rasterOf(png));
    }
  });

  it('leaves the band segment addressable inside the rebuilt IDAT', async () => {
    const png = bandingFixture(256, 256, 6, 8);
    const header = parsePng(png).header;
    const band = { rows: 64, y0: 64 };
    const banded = await normalizePngForBanding({ band, level: 6, png });
    const idat = parsePng(banded.base).idat;

    expect(banded.bandRange.offset).toBeGreaterThanOrEqual(2);
    expect(banded.bandRange.offset + banded.bandRange.length).toBeLessThan(idat.byteLength - 4);
    // The segment ends at a full flush, so it carries no BFINAL of its own; the
    // materializer appends a final empty block before inflating it alone.
    const sealed = new Uint8Array(banded.bandRange.length + 5);
    sealed.set(
      idat.subarray(banded.bandRange.offset, banded.bandRange.offset + banded.bandRange.length)
    );
    sealed.set([0x01, 0x00, 0x00, 0xff, 0xff], banded.bandRange.length);
    const bandFiltered = new Uint8Array(inflateRawSync(Buffer.from(sealed)));
    expect(bandFiltered.byteLength).toBe((header.rowBytes + 1) * band.rows);
  });

  it('pins the index the materializer reads (lockstep with ca-coupling)', async () => {
    // Numbers mirrored in ca-coupling/src/pngBandSplice.test.ts. Changing the
    // band format means changing both, deliberately, in the same commit.
    const png = bandingFixture(512, 512, 6, 8);
    const header = parsePng(png).header;
    const planned = planBand(header, { blocks: 864, minFraction: 0.05 });
    const band = placeBand(
      header,
      planned as { rows: number; y0: number },
      Uint8Array.from([7, 7])
    );
    const banded = await normalizePngForBanding({ band, level: 6, png });

    expect({
      baseSha256: createHash('sha256').update(banded.base).digest('hex'),
      length: banded.bandRange.length,
      offset: banded.bandRange.offset,
      prefixAdler: banded.prefixAdler,
      rows: band.rows,
      suffixAdler: banded.suffixAdler,
      suffixFilteredLength: banded.suffixFilteredLength,
      y0: band.y0,
    }).toEqual({
      // These bytes are Bun's streaming deflate at level 6 with 256 KiB
      // batches. Deflate output is not unique across backends, and Bun's
      // one-shot and streaming APIs are different backends, so this pin
      // catches accidental drift of this implementation rather than defining
      // a cross-compressor invariant. Regenerating it means regenerating
      // ca-coupling/src/testdata/bandedBase512.ts in the same commit; the
      // consumption test over that fixture is the real cross-repo lockstep.
      baseSha256: 'bfd8185923ec444f5337e6ca29ed97e70bf39948bcea306b96aa9cb19c4d92b6',
      length: 3219,
      offset: 4072,
      prefixAdler: 576628372,
      rows: 112,
      suffixAdler: 1828093411,
      suffixFilteredLength: 491760,
      y0: 160,
    });
  });

  it('routes what it cannot band away rather than mangling it', async () => {
    const parsed = parsePng(bandingFixture(64, 64, 6, 8));
    for (const mutate of [
      (h: Uint8Array) => {
        h[9] = 3;
      }, // palette
      (h: Uint8Array) => {
        h[9] = 0;
      }, // greyscale
      (h: Uint8Array) => {
        h[9] = 4;
      }, // greyscale + alpha
      (h: Uint8Array) => {
        h[12] = 1;
      }, // interlaced
      (h: Uint8Array) => {
        h[8] = 4;
      }, // sub-byte depth
    ]) {
      const ihdr = Uint8Array.from(parsed.raw);
      mutate(ihdr);
      const png = new Uint8Array([
        ...SIG,
        ...encodeChunk('IHDR', ihdr),
        ...encodeChunk('IDAT', parsed.idat),
        ...encodeChunk('IEND', new Uint8Array(0)),
      ]);
      expect(() => parsePng(png)).toThrow(PngBandError);
    }
  });

  it('declines to band an image the band would swallow whole', async () => {
    // 864 blocks need 108 block rows at 8 blocks across: taller than the image.
    const header = parsePng(bandingFixture(64, 64, 6, 8)).header;
    expect(planBand(header, { blocks: 864, minFraction: 0.05 })).toBeNull();
  });
});
