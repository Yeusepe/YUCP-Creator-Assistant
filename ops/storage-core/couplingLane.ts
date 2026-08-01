// Routing thresholds for materializer coupling in Cloudflare Workers (128MB isolate).
// Must stay aligned with the enforcement caps in ca-coupling src/workerCoupling.ts
// (WORKER_LANE_MAX_PIXELS / WORKER_LANE_FBX_MAX_SOURCE_BYTES): the worker refuses
// anything routed to it beyond those caps.
export const COUPLING_WORKER_MAX_PNG_PIXELS = 16_384 * 16_384;
export const COUPLING_WORKER_MAX_PNG_DIMENSION = 16_384;
// Non-streamable PNGs (palette/interlaced) fall back to the whole-buffer decoder,
// whose measured wasm peak is ~78 MiB at 2048x2048 and ~308 MiB at 4096x4096 —
// the latter exceeds the 128 MiB isolate, so the fallback cap stays at 2048².
export const COUPLING_WORKER_MAX_PNG_FALLBACK_PIXELS = 2048 * 2048;
export const COUPLING_WORKER_MAX_FBX_BYTES = 24 * 1024 * 1024;

// A nested ZIP is coupled entry by entry, but the rebuilt archive is assembled
// whole before it is stored, so the isolate has to hold the expanded contents.
// This is the total uncompressed size across entries, not the archive size, so
// a small archive that expands enormously still routes to the container.
export const COUPLING_WORKER_MAX_ZIP_TOTAL_BYTES = 64 * 1024 * 1024;
export const COUPLING_WORKER_MAX_ZIP_ENTRIES = 4096;

// 8-byte signature + IHDR length/type (8) + IHDR data (13) + CRC (4).
export const PNG_HEADER_BYTES = 33;
// End-of-central-directory record plus room for the comment field it may carry.
export const ZIP_TRAILER_BYTES = 66 * 1024;

export type CouplingLane = 'container' | 'worker';

export type CouplingLaneLimits = {
  maxFbxBytes: number;
  maxPngFallbackPixels: number;
  maxPngDimension: number;
  maxPngPixels: number;
  maxZipEntries: number;
  maxZipTotalBytes: number;
};

const DEFAULT_LIMITS: CouplingLaneLimits = {
  maxFbxBytes: COUPLING_WORKER_MAX_FBX_BYTES,
  maxPngFallbackPixels: COUPLING_WORKER_MAX_PNG_FALLBACK_PIXELS,
  maxPngDimension: COUPLING_WORKER_MAX_PNG_DIMENSION,
  maxPngPixels: COUPLING_WORKER_MAX_PNG_PIXELS,
  maxZipEntries: COUPLING_WORKER_MAX_ZIP_ENTRIES,
  maxZipTotalBytes: COUPLING_WORKER_MAX_ZIP_TOTAL_BYTES,
};

export function resolveCouplingLane(
  input: {
    bytes: number;
    materializerType: string;
    pngHeight?: number;
    pngStreamingSupported?: boolean;
    pngWidth?: number;
    zipEntries?: number;
    zipTotalBytes?: number;
  },
  limits: CouplingLaneLimits = DEFAULT_LIMITS
): CouplingLane {
  switch (input.materializerType) {
    case 'png':
      return input.pngWidth !== undefined &&
        input.pngHeight !== undefined &&
        input.pngWidth <= limits.maxPngDimension &&
        input.pngHeight <= limits.maxPngDimension &&
        input.pngWidth * input.pngHeight <=
          (input.pngStreamingSupported ? limits.maxPngPixels : limits.maxPngFallbackPixels)
        ? 'worker'
        : 'container';
    case 'fbx':
      return input.bytes <= limits.maxFbxBytes ? 'worker' : 'container';
    case 'zip':
      // An unreadable directory leaves both undefined, which must not be read
      // as "small enough" — only a directory we actually parsed can promote.
      return input.zipEntries !== undefined &&
        input.zipTotalBytes !== undefined &&
        input.zipEntries <= limits.maxZipEntries &&
        input.zipTotalBytes <= limits.maxZipTotalBytes
        ? 'worker'
        : 'container';
    default:
      return 'container';
  }
}

// resolveCouplingLane above answers "does this ONE file fit the isolate's
// memory?". That is not the same question as "should this JOB run in the
// isolate at all", and conflating the two is what made a 124-file release take
// four minutes: every file individually fit, so the dispatcher marked the whole
// job worker-lane and skipped container allocation, and 124 files' worth of
// codec then serialised on one single-threaded isolate.
//
// A Worker request cannot parallelise CPU work — no threads, and Cloudflare
// documents its isolate-spreading heuristics as imprecise — so the worker lane
// costs the SUM of every file, while the container lane has real cores.
//
// Measured on the production corpus (Druffle Avatar 1.0, 787 megapixels across
// 124 protected files): the wasm codec costs ~224 ms per megapixel in a Worker
// isolate, and codec cost tracks pixels, not bytes (r = 0.95 against pixel
// count, 0.68 against source bytes). So the job budget is denominated in
// megapixels.
//
export type CouplingJobFile = {
  couplingLane?: CouplingLane | undefined;
  pixelHeight?: number | undefined;
  pixelWidth?: number | undefined;
};

/**
 * Decides whether a whole job takes the in-isolate worker lane.
 *
 * Workers only, by requirement: every job whose files individually fit the
 * isolate runs there. This function briefly also bounded the job's aggregate
 * size (48 files / 96 megapixels) and sent anything larger to the container
 * lane; that rerouting is gone. It contradicted the requirement, and it also
 * moved real packages onto a path that does not band, so the splice work never
 * ran for exactly the packages it was built for. The CPU worry it answered is
 * handled where it belongs: the workflow shards files six to a step, each step
 * gets its own 300 s CPU budget, and banding cut per-file codec cost ~5x.
 *
 * 'container' here means the legacy path, reached only by a file that cannot
 * run in a Worker at all (exceeds isolate memory, or predates lane stamping),
 * never by job size. Empty lists stay on the legacy path: a job with no
 * protected files has nothing to couple in-isolate.
 */
export function resolveJobCouplingLane(files: readonly CouplingJobFile[]): CouplingLane {
  if (files.length < 1 || files.some((file) => file.couplingLane !== 'worker')) {
    return 'container';
  }
  return 'worker';
}

export type ZipCouplingMetadata = {
  entries: number;
  totalBytes: number;
};

/**
 * Sums the uncompressed sizes in a ZIP central directory so the lane router can
 * tell a small archive from one that expands past the isolate. Reads the tail
 * of the file only. Returns null when the directory is absent, truncated, or
 * uses Zip64, all of which mean the archive cannot be proven worker-safe.
 */
export function readZipCouplingMetadata(tailBytes: Uint8Array): ZipCouplingMetadata | null {
  const view = new DataView(tailBytes.buffer, tailBytes.byteOffset, tailBytes.byteLength);
  let endOffset = -1;
  // The EOCD comment is variable length, so scan back for the signature.
  for (let offset = tailBytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    return null;
  }
  const entries = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  // Zip64 parks 0xffff/0xffffffff here and moves the real values elsewhere.
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    return null;
  }
  // The directory has to sit inside the tail we were given to be summable; a
  // directory that starts before it cannot be proven small and stays container.
  const start = endOffset - directorySize;
  if (start < 0) {
    return null;
  }

  let cursor = start;
  let totalBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > endOffset || view.getUint32(cursor, true) !== 0x02014b50) {
      return null;
    }
    const uncompressedSize = view.getUint32(cursor + 24, true);
    if (uncompressedSize === 0xffffffff) {
      return null;
    }
    totalBytes += uncompressedSize;
    if (!Number.isSafeInteger(totalBytes)) {
      return null;
    }
    cursor +=
      46 +
      view.getUint16(cursor + 28, true) +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
  }
  return cursor === endOffset ? { entries, totalBytes } : null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type PngCouplingMetadata = {
  height: number;
  streamingSupported: boolean;
  width: number;
};

export function readPngCouplingMetadata(bytes: Uint8Array): PngCouplingMetadata | null {
  if (bytes.length < 29 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // First chunk must be IHDR with a 13-byte payload.
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) {
    return null;
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
    return null;
  }
  const bitDepth = bytes[24] as number;
  const colorType = bytes[25] as number;
  const compressionMethod = bytes[26] as number;
  const filterMethod = bytes[27] as number;
  const interlaceMethod = bytes[28] as number;
  return {
    height,
    streamingSupported:
      (bitDepth === 8 || bitDepth === 16) &&
      (colorType === 0 || colorType === 2 || colorType === 4 || colorType === 6) &&
      compressionMethod === 0 &&
      filterMethod === 0 &&
      interlaceMethod === 0,
    width,
  };
}

export function readPngDimensions(bytes: Uint8Array): { height: number; width: number } | null {
  const metadata = readPngCouplingMetadata(bytes);
  return metadata ? { height: metadata.height, width: metadata.width } : null;
}
