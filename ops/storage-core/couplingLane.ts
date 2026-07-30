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

// 8-byte signature + IHDR length/type (8) + IHDR data (13) + CRC (4).
export const PNG_HEADER_BYTES = 33;

export type CouplingLane = 'container' | 'worker';

export type CouplingLaneLimits = {
  maxFbxBytes: number;
  maxPngFallbackPixels: number;
  maxPngDimension: number;
  maxPngPixels: number;
};

const DEFAULT_LIMITS: CouplingLaneLimits = {
  maxFbxBytes: COUPLING_WORKER_MAX_FBX_BYTES,
  maxPngFallbackPixels: COUPLING_WORKER_MAX_PNG_FALLBACK_PIXELS,
  maxPngDimension: COUPLING_WORKER_MAX_PNG_DIMENSION,
  maxPngPixels: COUPLING_WORKER_MAX_PNG_PIXELS,
};

export function resolveCouplingLane(
  input: {
    bytes: number;
    materializerType: string;
    pngHeight?: number;
    pngStreamingSupported?: boolean;
    pngWidth?: number;
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
    default:
      // zip and anything unrecognized always take the container lane.
      return 'container';
  }
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
