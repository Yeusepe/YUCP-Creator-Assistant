/**
 * Publish-time half of band splicing for protected PNGs.
 *
 * Coupling a 4096x4096 texture costs ~16.8 megapixels of decode and re-encode
 * to place 864 watermark blocks. The payload is capped at 864 blocks regardless
 * of resolution, so a 256x256 icon carries exactly the same identifying
 * capacity for 1/256th of the work: the cost curve is driven by a quantity that
 * contributes nothing to identification.
 *
 * Banding lets a buyer's coupling touch only a band of the image. Here, at
 * publish, a PNG is re-encoded as three independently-deflatable segments --
 * (prefix, band, suffix) separated by Z_FULL_FLUSH, which resets the LZ77
 * dictionary so each segment can be decoded and replaced on its own. The
 * materializer then copies the prefix and suffix compressed bytes verbatim per
 * buyer and re-deflates only the band.
 *
 * Re-encoding is lossless: same pixels, same bit depth, same colour type, only
 * a different IDAT bitstream. The band never leaves this file's own arithmetic,
 * so a banded base is a plain valid PNG that anything can read.
 *
 * LOCKSTEP: the couple-time half lives in the materializer repo as
 * ca-coupling/src/pngBandSplice.ts, of which this is a verbatim subset. The two
 * agree through the recorded index rather than through re-derivation: the
 * materializer verifies the base against its sha256 before slicing it, so an
 * index computed here against those exact bytes stays correct. What must not
 * drift is the meaning of the recorded fields and the adler32 arithmetic;
 * pngBanding.test.ts pins both against a golden vector the other repo shares.
 *
 * Two invariants make the segments independent, and both are established here
 * rather than assumed:
 *   - Z_FULL_FLUSH between segments, so no LZ77 back-reference crosses a
 *     boundary and the deflate stream can be cut and rejoined at that point.
 *   - Filter type 0 on the first row of the band and of the suffix, because a
 *     PNG filter references the previous row and those rows no longer own it.
 */

import { once } from 'node:events';
import { constants, createDeflateRaw, createInflate } from 'node:zlib';

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A protected source is already capped upstream; these bound this module's own
// parsing against a malformed or hostile file rather than restating policy.
export const BAND_MAX_PIXELS = 16_384 * 16_384;
export const BAND_MAX_CHUNK_BYTES = 256 * 1024 * 1024;
// 16384x16384 RGBA8 plus its filter bytes, the largest raster the worker lane
// admits. Bounds what a header alone can make this module allocate.
export const BAND_MAX_RASTER_BYTES = 16_384 * (16_384 * 4 + 1);

/**
 * This source or index cannot be banded. Callers treat it as "couple whole",
 * so it must never be raised for anything that is actually broken.
 */
export class PngBandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngBandError';
  }
}

export type PngChunk = { data: Uint8Array; type: string };

export type PngHeader = {
  bitDepth: number;
  bytesPerPixel: number;
  channels: number;
  colorType: number;
  height: number;
  interlace: number;
  rowBytes: number;
  width: number;
};

export type BandPlacement = { rows: number; y0: number };

/**
 * The publish-time artefact. `base` is a complete, valid PNG whose IDAT is
 * three flush-separated segments; the rest lets a buyer's splice rebuild it
 * without re-reading or re-parsing the original.
 */
export type BandedPng = {
  band: BandPlacement;
  base: Uint8Array;
  /** Compressed byte range of the band segment inside the IDAT payload. */
  bandRange: { length: number; offset: number };
  /** Running adler32 of the filtered prefix, and of the filtered suffix. */
  prefixAdler: number;
  suffixAdler: number;
  suffixFilteredLength: number;
};

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/**
 * crc32, resumable so a chunk can be checksummed while it is written rather
 * than after it is assembled. `crc32(b, crc32(a))` equals `crc32(a || b)`.
 */
export function crc32(bytes: Uint8Array, seed = 0): number {
  let c = ~seed;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

/** Rolling adler32 so the three segments can be summed without concatenating. */
export function adler32(bytes: Uint8Array, seed = 1): number {
  let a = seed & 0xffff;
  let b = (seed >>> 16) & 0xffff;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + (bytes[i] as number)) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] as number) << 24) |
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number)) >>>
    0
  );
}

function writeUint32(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function encodeChunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat([Uint8Array.from(type, (c) => c.charCodeAt(0)), data]);
  return concat([writeUint32(data.byteLength), body, writeUint32(crc32(body))]);
}

/** Bytes a chunk occupies: length, type, payload, crc. */
function chunkSize(payloadLength: number): number {
  return 12 + payloadLength;
}

/**
 * Writes one chunk directly into `out`, checksumming as it copies.
 *
 * The alternative, building each chunk with encodeChunk and concatenating,
 * holds four full-size copies of a multi-megabyte IDAT at once. That is what
 * exceeded the 128 MiB isolate on a real release.
 */
function writeChunkInto(
  out: Uint8Array,
  offset: number,
  type: string,
  parts: readonly Uint8Array[]
): number {
  let payloadLength = 0;
  for (const part of parts) {
    payloadLength += part.byteLength;
  }
  out.set(writeUint32(payloadLength), offset);
  let cursor = offset + 4;
  const typeBytes = Uint8Array.from(type, (c) => c.charCodeAt(0));
  out.set(typeBytes, cursor);
  cursor += 4;
  let crc = crc32(typeBytes);
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.byteLength;
    crc = crc32(part, crc);
  }
  out.set(writeUint32(crc), cursor);
  return cursor + 4;
}

export function parsePng(bytes: Uint8Array): {
  header: PngHeader;
  idat: Uint8Array;
  /** Everything between IHDR and IDAT: PLTE, tRNS and friends must survive. */
  interstitial: PngChunk[];
  raw: Uint8Array;
} {
  if (
    bytes.byteLength < PNG_SIGNATURE.byteLength ||
    PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)
  ) {
    throw new PngBandError('Not a PNG');
  }
  let offset = PNG_SIGNATURE.byteLength;
  let ihdr: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];
  const interstitial: PngChunk[] = [];
  while (offset + 12 <= bytes.byteLength) {
    const length = readUint32(bytes, offset);
    if (length > BAND_MAX_CHUNK_BYTES || offset + 12 + length > bytes.byteLength) {
      throw new PngBandError('PNG chunk length is out of range');
    }
    const type = String.fromCharCode(
      bytes[offset + 4] as number,
      bytes[offset + 5] as number,
      bytes[offset + 6] as number,
      bytes[offset + 7] as number
    );
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      ihdr = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    } else {
      interstitial.push({ data, type });
    }
    offset += 12 + length;
  }
  if (!ihdr || ihdr.byteLength !== 13 || idatParts.length < 1) {
    throw new PngBandError('PNG is missing IHDR or IDAT');
  }
  const width = readUint32(ihdr, 0);
  const height = readUint32(ihdr, 4);
  const bitDepth = ihdr[8] as number;
  const colorType = ihdr[9] as number;
  // Compression and filter method are the only values PNG defines, but a file
  // can still declare others. The codec's own probe rejects them, so this has
  // to as well or the two would disagree about what they are looking at.
  const compressionMethod = ihdr[10] as number;
  const filterMethod = ihdr[11] as number;
  const interlace = ihdr[12] as number;
  if (
    width < 1 ||
    height < 1 ||
    width * height > BAND_MAX_PIXELS ||
    (bitDepth !== 8 && bitDepth !== 16) ||
    (colorType !== 2 && colorType !== 6) ||
    compressionMethod !== 0 ||
    filterMethod !== 0 ||
    interlace !== 0
  ) {
    // Palette, interlaced and sub-byte depths have no band story, and greyscale
    // has an ambiguous one: expanding grey to RGB replicates one sample into
    // three, and no watermark profile says which of the three it then marks, so
    // the inverse could silently drop the mark. All of them couple whole. This
    // is a routing decision, not a failure.
    throw new PngBandError('PNG is not eligible for banding');
  }
  const channels = colorType === 2 ? 3 : 4;
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  // A pixel bound alone is not an allocation bound: 16-bit RGBA at the pixel
  // cap declares 8 GiB of raster, and unfilterScanlines would try to allocate
  // it from a header alone, before a single compressed byte is read.
  if ((rowBytes + 1) * height > BAND_MAX_RASTER_BYTES) {
    throw new PngBandError('PNG raster exceeds the band size bound');
  }
  return {
    header: {
      bitDepth,
      bytesPerPixel: Math.max(1, (channels * bitDepth) / 8),
      channels,
      colorType,
      height,
      interlace,
      rowBytes,
      width,
    },
    idat: concat(idatParts),
    interstitial,
    raw: ihdr,
  };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

/** Reverses PNG scanline filtering into raw samples. */
export function unfilterScanlines(header: PngHeader, filtered: Uint8Array): Uint8Array {
  const stride = header.rowBytes + 1;
  if (filtered.byteLength < stride * header.height) {
    throw new PngBandError('Filtered scanline data is truncated');
  }
  const bpp = header.bytesPerPixel;
  const raw = new Uint8Array(header.rowBytes * header.height);
  for (let y = 0; y < header.height; y += 1) {
    const filterType = filtered[y * stride] as number;
    if (filterType > 4) {
      throw new PngBandError('Unknown PNG filter type');
    }
    const rowStart = y * header.rowBytes;
    const prevStart = rowStart - header.rowBytes;
    for (let i = 0; i < header.rowBytes; i += 1) {
      const a = i >= bpp ? (raw[rowStart + i - bpp] as number) : 0;
      const b = y > 0 ? (raw[prevStart + i] as number) : 0;
      const c = y > 0 && i >= bpp ? (raw[prevStart + i - bpp] as number) : 0;
      const x = filtered[y * stride + 1 + i] as number;
      let value: number;
      switch (filterType) {
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4:
          value = x + paeth(a, b, c);
          break;
        default:
          value = x;
      }
      raw[rowStart + i] = value & 0xff;
    }
  }
  return raw;
}

/**
 * Emits rows [y0, y0+rows) with filter type 0.
 *
 * Filter 0 is not a compression choice here, it is what makes a segment
 * self-contained: any other filter would reference the row above, which the
 * prefix owns and the band is about to replace.
 */
export function filterScanlinesNone(
  header: PngHeader,
  raw: Uint8Array,
  y0: number,
  rows: number
): Uint8Array {
  const stride = header.rowBytes + 1;
  const out = new Uint8Array(stride * rows);
  for (let y = 0; y < rows; y += 1) {
    out[y * stride] = 0;
    out.set(
      raw.subarray((y0 + y) * header.rowBytes, (y0 + y + 1) * header.rowBytes),
      y * stride + 1
    );
  }
  return out;
}

/**
 * Copies already-filtered rows [y0, y0+rows) verbatim, rewriting only the first
 * row to filter 0.
 *
 * Only that one row has lost anything: a PNG filter references the row above,
 * and the row above this segment either gets replaced per buyer or is never
 * inflated. Every other row still owns its predecessor, so its original filter
 * is still valid, and worth keeping: flattening a whole image to
 * filter 0 costs about 30% of its compressed size.
 */
export function retainFilteredRows(
  header: PngHeader,
  filtered: Uint8Array,
  raw: Uint8Array,
  y0: number,
  rows: number
): Uint8Array {
  const stride = header.rowBytes + 1;
  if (rows < 1) {
    return new Uint8Array(0);
  }
  const out = filtered.slice(y0 * stride, (y0 + rows) * stride);
  out[0] = 0;
  out.set(raw.subarray(y0 * header.rowBytes, (y0 + 1) * header.rowBytes), 1);
  return out;
}

const FILTER_COUNT = 5;

/**
 * Re-filters rows [y0, y0+rows), picking per row the filter whose output has
 * the smallest sum of absolute signed values, the heuristic libpng uses and
 * the reason a PNG compresses at all. The first row is forced to filter 0 for
 * the same reason as above.
 *
 * The couple side needs this because it rebuilds the band from marked pixels
 * and has no original filters left to keep.
 */
export function filterScanlinesAdaptive(
  header: PngHeader,
  raw: Uint8Array,
  y0: number,
  rows: number
): Uint8Array {
  const { rowBytes } = header;
  const bpp = header.bytesPerPixel;
  const stride = rowBytes + 1;
  const out = new Uint8Array(stride * rows);
  const candidate = new Uint8Array(rowBytes);
  for (let y = 0; y < rows; y += 1) {
    const rowStart = (y0 + y) * rowBytes;
    const prevStart = rowStart - rowBytes;
    const hasPrev = y > 0;
    let bestType = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let type = 0; type < (hasPrev ? FILTER_COUNT : 1); type += 1) {
      let score = 0;
      for (let i = 0; i < rowBytes; i += 1) {
        const x = raw[rowStart + i] as number;
        const a = i >= bpp ? (raw[rowStart + i - bpp] as number) : 0;
        const b = hasPrev ? (raw[prevStart + i] as number) : 0;
        const c = hasPrev && i >= bpp ? (raw[prevStart + i - bpp] as number) : 0;
        let value: number;
        switch (type) {
          case 1:
            value = x - a;
            break;
          case 2:
            value = x - b;
            break;
          case 3:
            value = x - ((a + b) >> 1);
            break;
          case 4:
            value = x - paeth(a, b, c);
            break;
          default:
            value = x;
        }
        value &= 0xff;
        candidate[i] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        out.set(candidate, y * stride + 1);
      }
    }
    out[y * stride] = bestType;
  }
  return out;
}

/**
 * Largest RGBA raster a planned band may expand to at couple time.
 *
 * The couple side holds the band's raster several times over inside a 128 MiB
 * isolate, and it refuses bands past its own bound by falling back to a
 * slower strip re-encode. The plan stays under that bound so the fast splice
 * path survives any dimensions: the 5% fraction floor alone gave a
 * 14104x14103 source a 712-row band, a 40 MB raster from a 1.1 MB file.
 */
const PLAN_BAND_MAX_RASTER_BYTES = 8 * 1024 * 1024;

/**
 * Smallest band, in whole 8-row block rows, that can hold `blocks` watermark
 * blocks, widened to at least `minFraction` of the image so a saturated region
 * still has candidates, and capped so its raster fits the couple-time
 * isolate. Returns null when the band would be the whole image, which means
 * banding buys nothing and the caller should couple it whole.
 */
export function planBand(
  header: PngHeader,
  options: { blocks: number; minFraction: number }
): BandPlacement | null {
  const blocksPerRow = Math.floor(header.width / 8);
  if (blocksPerRow < 1) {
    return null;
  }
  const needed = Math.ceil(options.blocks / blocksPerRow);
  const fractional = Math.ceil(Math.floor(header.height / 8) * options.minFraction);
  const budget = Math.floor(PLAN_BAND_MAX_RASTER_BYTES / (header.width * 4) / 8);
  const rows = Math.max(needed, Math.min(fractional, budget), 1) * 8;
  if (rows >= header.height || rows * header.width * 4 > PLAN_BAND_MAX_RASTER_BYTES) {
    return null;
  }
  return { rows, y0: 0 };
}

/** Places the band at a keyed, 8-row-aligned offset so it is not predictable. */
export function placeBand(
  header: PngHeader,
  band: BandPlacement,
  selector: Uint8Array
): BandPlacement {
  const slots = Math.floor((header.height - band.rows) / 8) + 1;
  if (slots < 2) {
    return { rows: band.rows, y0: 0 };
  }
  let acc = 0;
  for (let i = 0; i < selector.byteLength; i += 1) {
    acc = (acc * 31 + (selector[i] as number)) >>> 0;
  }
  return { rows: band.rows, y0: (acc % slots) * 8 };
}

/**
 * Publish-time step: rebuild `png` so its IDAT is prefix|band|suffix, each
 * independently replaceable.
 *
 * The rows stream through one deflate that is cut at the two band boundaries
 * with Z_FULL_FLUSH, so the peak is two rows plus the compressed streams
 * rather than the raster. Dimensions, not bytes, are the raster cost: a
 * 14104x14103 source is 1.1 MB of file and 796 MB of raster, and the raster
 * version of this function froze the publish host on exactly that shape. The
 * output is byte-identical to deflating the three segments independently,
 * because a full flush resets the dictionary and byte-aligns, which is also
 * how a fresh deflate of the same bytes starts.
 *
 * The source's own filters are kept everywhere they are still valid, which is
 * everywhere except the first row of the band and of the suffix; re-filtering
 * a whole image to 0 measured 29% larger on the production corpus. Every row
 * is still unfiltered in passing, two rows live, so those boundary rows have
 * their pixels when the stream reaches them.
 */
export async function normalizePngForBanding(input: {
  band: BandPlacement;
  level?: number;
  png: Uint8Array;
}): Promise<BandedPng> {
  const parsed = parsePng(input.png);
  const { header } = parsed;
  const { band } = input;
  if (
    band.y0 < 0 ||
    band.rows < 1 ||
    band.y0 % 8 !== 0 ||
    band.rows % 8 !== 0 ||
    band.y0 + band.rows > header.height
  ) {
    throw new PngBandError('Band placement is out of range');
  }
  const stride = header.rowBytes + 1;
  const bpp = header.bytesPerPixel;
  const { rowBytes } = header;
  const suffixRows = header.height - band.y0 - band.rows;
  const boundaries = new Set(suffixRows > 0 ? [band.y0, band.y0 + band.rows] : [band.y0]);

  const deflater = createDeflateRaw({ level: input.level ?? 6 });
  const segments: [Uint8Array[], Uint8Array[], Uint8Array[]] = [[], [], []];
  let segmentIndex = 0;
  deflater.on('data', (chunk: Buffer) => {
    segments[segmentIndex as 0 | 1 | 2].push(new Uint8Array(chunk));
  });
  const writeRaw = async (bytes: Uint8Array): Promise<void> => {
    if (!deflater.write(bytes)) {
      await once(deflater, 'drain');
    }
  };
  // Rows are batched before they reach zlib. Bun routes one-shot and streaming
  // deflate through different backends, and its streaming one emits measurably
  // larger output when fed row-sized writes; at 64 KiB and above the two are
  // byte-identical, so batching is what keeps this function's output equal to
  // the one-shot implementation it replaced, and to the pinned golden vector.
  const batch = new Uint8Array(1 << 18);
  let batchFill = 0;
  const flushBatch = async (): Promise<void> => {
    if (batchFill > 0) {
      await writeRaw(batch.slice(0, batchFill));
      batchFill = 0;
    }
  };
  const writeFiltered = async (bytes: Uint8Array): Promise<void> => {
    if (batchFill + bytes.byteLength > batch.byteLength) {
      await flushBatch();
    }
    if (bytes.byteLength >= batch.byteLength) {
      await writeRaw(bytes.slice());
      return;
    }
    batch.set(bytes, batchFill);
    batchFill += bytes.byteLength;
  };
  const cutSegment = async (): Promise<void> => {
    await flushBatch();
    await new Promise<void>((resolve) => {
      deflater.flush(constants.Z_FULL_FLUSH, () => resolve());
    });
    segmentIndex += 1;
  };

  // The inflater is fed with backpressure while rows are consumed below, so
  // neither the compressed input nor the pixel stream is ever whole in memory.
  const inflater = createInflate();
  const feed = (async () => {
    const step = 1 << 16;
    for (let offset = 0; offset < parsed.idat.byteLength; offset += step) {
      const chunk = parsed.idat.subarray(offset, Math.min(offset + step, parsed.idat.byteLength));
      if (!inflater.write(chunk)) {
        await once(inflater, 'drain');
      }
    }
    inflater.end();
  })();

  // Segment-local adlers seed the index fields; the running chain becomes the
  // stream trailer. Both accumulate row by row.
  let segAdler = 1;
  let totalAdler = 1;
  let prefixAdler = 1;
  let suffixFilteredLength = 0;
  let previous = new Uint8Array(rowBytes);
  let current = new Uint8Array(rowBytes);
  let havePrevious = false;
  let y = 0;

  const processRow = async (row: Uint8Array): Promise<void> => {
    const filterType = row[0] as number;
    if (filterType > 4) {
      throw new PngBandError('Unknown PNG filter type');
    }
    for (let i = 0; i < rowBytes; i += 1) {
      const a = i >= bpp ? (current[i - bpp] as number) : 0;
      const b = havePrevious ? (previous[i] as number) : 0;
      const c = havePrevious && i >= bpp ? (previous[i - bpp] as number) : 0;
      const x = row[1 + i] as number;
      let value: number;
      switch (filterType) {
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4:
          value = x + paeth(a, b, c);
          break;
        default:
          value = x;
      }
      current[i] = value & 0xff;
    }
    let out = row;
    if (boundaries.has(y)) {
      if (segmentIndex === 0) {
        prefixAdler = segAdler;
      }
      await cutSegment();
      segAdler = 1;
      // The first row of a segment loses its reference row, so it is rewritten
      // to filter 0 with its absolute bytes.
      out = new Uint8Array(stride);
      out.set(current, 1);
    }
    segAdler = adler32(out, segAdler);
    totalAdler = adler32(out, totalAdler);
    if (segmentIndex === 2) {
      suffixFilteredLength += out.byteLength;
    }
    await writeFiltered(out);
    const swap = previous;
    previous = current;
    current = swap;
    havePrevious = true;
    y += 1;
  };

  let buffered = new Uint8Array(0);
  for await (const piece of inflater) {
    let chunk: Uint8Array;
    if (buffered.byteLength > 0) {
      chunk = new Uint8Array(buffered.byteLength + (piece as Buffer).byteLength);
      chunk.set(buffered, 0);
      chunk.set(new Uint8Array(piece as Buffer), buffered.byteLength);
    } else {
      chunk = new Uint8Array(piece as Buffer);
    }
    let offset = 0;
    while (chunk.byteLength - offset >= stride && y < header.height) {
      await processRow(chunk.subarray(offset, offset + stride));
      offset += stride;
    }
    buffered = chunk.slice(offset);
  }
  await feed;
  if (y !== header.height || buffered.byteLength !== 0) {
    throw new PngBandError('Filtered scanline data is truncated');
  }
  await flushBatch();
  if (suffixRows === 0) {
    // The band is the last segment with rows; close it at a flush so its
    // compressed bytes stay independently replaceable, exactly as when a
    // suffix follows.
    if (segmentIndex === 0) {
      prefixAdler = segAdler;
    }
    await cutSegment();
  }
  const ended = once(deflater, 'end');
  deflater.end();
  await ended;
  const suffixAdler = suffixRows > 0 ? segAdler : 1;

  const prefixLength = segments[0].reduce((total, part) => total + part.byteLength, 0);
  const bandLength = segments[1].reduce((total, part) => total + part.byteLength, 0);
  // 0x78 0x9c: deflate, 32 KiB window, default level. The window size must
  // cover the largest back-reference any segment can make.
  const idatParts = [
    Uint8Array.from([0x78, 0x9c]),
    ...segments[0],
    ...segments[1],
    ...segments[2],
    writeUint32(totalAdler),
  ];
  let idatLength = 0;
  for (const part of idatParts) {
    idatLength += part.byteLength;
  }
  // Single allocation, same reason as spliceBandedPng: chaining concat here
  // held four copies of a multi-megabyte IDAT at once.
  let baseLength =
    PNG_SIGNATURE.byteLength +
    chunkSize(parsed.raw.byteLength) +
    chunkSize(idatLength) +
    chunkSize(0);
  for (const chunk of parsed.interstitial) {
    baseLength += chunkSize(chunk.data.byteLength);
  }
  const base = new Uint8Array(baseLength);
  base.set(PNG_SIGNATURE, 0);
  let cursor = PNG_SIGNATURE.byteLength;
  cursor = writeChunkInto(base, cursor, 'IHDR', [parsed.raw]);
  for (const chunk of parsed.interstitial) {
    cursor = writeChunkInto(base, cursor, chunk.type, [chunk.data]);
  }
  cursor = writeChunkInto(base, cursor, 'IDAT', idatParts);
  writeChunkInto(base, cursor, 'IEND', []);

  return {
    band,
    bandRange: { length: bandLength, offset: 2 + prefixLength },
    base,
    prefixAdler,
    suffixAdler,
    suffixFilteredLength,
  };
}
