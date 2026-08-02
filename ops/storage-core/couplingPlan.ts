const MEBIBYTE = 1024 * 1024;
const UINT32_MAX = 0xffff_ffff;

export const COUPLING_DYNAMIC_BUDGET_BYTES = 72 * MEBIBYTE;
export const COUPLING_BAND_RASTER_MAX_BYTES = 8 * MEBIBYTE;
export const COUPLING_FBX_SOURCE_MAX_BYTES = 8 * MEBIBYTE;
export const COUPLING_PLAN_RESERVE_BYTES = 4 * MEBIBYTE;
export const COUPLING_PNG_MAX_DIMENSION = 16_384;
export const COUPLING_PNG_MAX_PIXELS = 16_384 * 16_384;

export type BandPlanV1 = {
  idatPrefixCrc32: number;
  idatSuffixCrc32: number;
  idatSuffixLength: number;
  length: number;
  offset: number;
  prefixAdler: number;
  rows: number;
  suffixAdler: number;
  suffixFilteredLength: number;
  y0: number;
};

export type PngBandCouplingPlanV1 = {
  band: BandPlanV1;
  bitDepth: number;
  colorType: number;
  height: number;
  peakDynamicBytes: number;
  rowBytes: number;
  strategy: 'png-band-v1';
  width: number;
};

export type PngWholeCouplingPlanV1 = {
  bitDepth: number;
  colorType: number;
  height: number;
  peakDynamicBytes: number;
  rowBytes: number;
  strategy: 'png-whole-v1';
  width: number;
};

export type FbxCouplingPlanV1 = {
  peakDynamicBytes: number;
  strategy: 'fbx-v1';
};

export type CouplingPlan = FbxCouplingPlanV1 | PngBandCouplingPlanV1 | PngWholeCouplingPlanV1;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type PngGeometry = {
  bitDepth: number;
  colorType: number;
  height: number;
  rowBytes: number;
  width: number;
};

function checkedSum(...values: number[]): number {
  const result = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error('Coupling plan arithmetic overflowed');
  }
  return result;
}

function checkedProduct(left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error('Coupling plan arithmetic overflowed');
  }
  return result;
}

export function deflateBound(byteLength: number): number {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error('Deflate input length is invalid');
  }
  return checkedSum(
    byteLength,
    Math.ceil(byteLength / 4096),
    Math.ceil(byteLength / 16_384),
    Math.ceil(byteLength / 33_554_432),
    64
  );
}

function pngChannels(colorType: number): number {
  switch (colorType) {
    case 0:
    case 3:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      throw new Error('PNG color type is unsupported');
  }
}

function assertPngGeometry(input: PngGeometry, banded: boolean): void {
  const allowedDepths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  const channels = pngChannels(input.colorType);
  if (
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width < 1 ||
    input.height < 1 ||
    input.width > COUPLING_PNG_MAX_DIMENSION ||
    input.height > COUPLING_PNG_MAX_DIMENSION ||
    checkedProduct(input.width, input.height) > COUPLING_PNG_MAX_PIXELS ||
    !(allowedDepths[input.colorType] ?? []).includes(input.bitDepth) ||
    (banded && input.colorType !== 2 && input.colorType !== 6)
  ) {
    throw new Error('PNG geometry is unsupported');
  }
  const expectedRowBytes = Math.ceil(
    checkedProduct(checkedProduct(input.width, channels), input.bitDepth) / 8
  );
  if (input.rowBytes !== expectedRowBytes) {
    throw new Error('PNG rowBytes does not match its geometry');
  }
}

export function readPngGeometry(bytes: Uint8Array): PngGeometry | null {
  if (bytes.byteLength < 29 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) {
    return null;
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = bytes[24] as number;
  const colorType = bytes[25] as number;
  if (bytes[26] !== 0 || bytes[27] !== 0 || (bytes[28] !== 0 && bytes[28] !== 1)) {
    return null;
  }
  try {
    const rowBytes = Math.ceil((width * pngChannels(colorType) * bitDepth) / 8);
    const geometry = { bitDepth, colorType, height, rowBytes, width };
    assertPngGeometry(geometry, false);
    return geometry;
  } catch {
    return null;
  }
}

function assertFileBytes(fileBytes: number): void {
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 1) {
    throw new Error('Coupling source byte count is invalid');
  }
}

function assertFitsDynamicBudget(peakDynamicBytes: number): void {
  if (peakDynamicBytes > COUPLING_DYNAMIC_BUDGET_BYTES) {
    throw new Error('Coupling plan exceeds the Worker dynamic budget');
  }
}

export function computePngBandPeakDynamicBytes(input: {
  fileBytes: number;
  rowBytes: number;
  rows: number;
  width: number;
}): number {
  assertFileBytes(input.fileBytes);
  const nativeBandBytes = checkedProduct(input.rowBytes, input.rows);
  const rgbaBytes = checkedProduct(checkedProduct(input.width, input.rows), 4);
  if (
    nativeBandBytes > COUPLING_BAND_RASTER_MAX_BYTES ||
    rgbaBytes > COUPLING_BAND_RASTER_MAX_BYTES
  ) {
    throw new Error('PNG band raster exceeds the v1 bound');
  }
  const filteredBytes = checkedSum(nativeBandBytes, input.rows);
  return checkedSum(
    input.fileBytes,
    nativeBandBytes,
    Math.max(
      checkedSum(rgbaBytes, deflateBound(checkedSum(rgbaBytes, input.rows))),
      checkedSum(filteredBytes, deflateBound(filteredBytes))
    ),
    COUPLING_PLAN_RESERVE_BYTES
  );
}

export function computePngWholePeakDynamicBytes(input: {
  fileBytes: number;
  height: number;
  rowBytes: number;
  width: number;
}): number {
  assertFileBytes(input.fileBytes);
  const nativeBytes = checkedProduct(input.rowBytes, input.height);
  const rgbaBytes = checkedProduct(checkedProduct(input.width, input.height), 4);
  const largestFilteredBytes = checkedSum(Math.max(nativeBytes, rgbaBytes), input.height);
  return checkedSum(
    input.fileBytes,
    nativeBytes,
    rgbaBytes,
    deflateBound(largestFilteredBytes),
    COUPLING_PLAN_RESERVE_BYTES
  );
}

export function computeFbxPeakDynamicBytes(fileBytes: number): number {
  assertFileBytes(fileBytes);
  if (fileBytes > COUPLING_FBX_SOURCE_MAX_BYTES) {
    throw new Error('FBX source exceeds the v1 bound');
  }
  return checkedSum(Math.ceil((fileBytes * 22) / 10), COUPLING_PLAN_RESERVE_BYTES);
}

function assertBandPlan(band: BandPlanV1, height: number): void {
  const values = Object.values(band);
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) ||
    band.length < 1 ||
    band.rows < 8 ||
    band.rows % 8 !== 0 ||
    band.y0 % 8 !== 0 ||
    band.y0 + band.rows > height ||
    band.rows >= height
  ) {
    throw new Error('PNG band index is invalid');
  }
}

export function createPngBandCouplingPlan(
  input: PngGeometry & { band: BandPlanV1; fileBytes: number }
): PngBandCouplingPlanV1 {
  assertPngGeometry(input, true);
  assertBandPlan(input.band, input.height);
  const peakDynamicBytes = computePngBandPeakDynamicBytes({
    fileBytes: input.fileBytes,
    rowBytes: input.rowBytes,
    rows: input.band.rows,
    width: input.width,
  });
  assertFitsDynamicBudget(peakDynamicBytes);
  return {
    band: input.band,
    bitDepth: input.bitDepth,
    colorType: input.colorType,
    height: input.height,
    peakDynamicBytes,
    rowBytes: input.rowBytes,
    strategy: 'png-band-v1',
    width: input.width,
  };
}

export function createPngWholeCouplingPlan(
  input: PngGeometry & { fileBytes: number }
): PngWholeCouplingPlanV1 {
  assertPngGeometry(input, false);
  const peakDynamicBytes = computePngWholePeakDynamicBytes(input);
  assertFitsDynamicBudget(peakDynamicBytes);
  return {
    bitDepth: input.bitDepth,
    colorType: input.colorType,
    height: input.height,
    peakDynamicBytes,
    rowBytes: input.rowBytes,
    strategy: 'png-whole-v1',
    width: input.width,
  };
}

export function createFbxCouplingPlan(fileBytes: number): FbxCouplingPlanV1 {
  const peakDynamicBytes = computeFbxPeakDynamicBytes(fileBytes);
  assertFitsDynamicBudget(peakDynamicBytes);
  return { peakDynamicBytes, strategy: 'fbx-v1' };
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  name: string
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...fields].sort().join(',')
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function integer(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Coupling plan ${field} is invalid`);
  }
  return value as number;
}

function parseBandPlan(value: unknown): BandPlanV1 {
  const fields = [
    'idatPrefixCrc32',
    'idatSuffixCrc32',
    'idatSuffixLength',
    'length',
    'offset',
    'prefixAdler',
    'rows',
    'suffixAdler',
    'suffixFilteredLength',
    'y0',
  ] as const;
  const record = exactRecord(value, fields, 'PNG band index');
  return Object.fromEntries(fields.map((field) => [field, integer(record, field)])) as BandPlanV1;
}

export function parseCouplingPlan(value: unknown, fileBytes: number): CouplingPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Coupling plan is invalid');
  }
  const strategy = (value as Record<string, unknown>).strategy;
  if (strategy === 'fbx-v1') {
    const record = exactRecord(value, ['peakDynamicBytes', 'strategy'], 'FBX coupling plan');
    const plan = createFbxCouplingPlan(fileBytes);
    if (integer(record, 'peakDynamicBytes') !== plan.peakDynamicBytes) {
      throw new Error('Coupling plan peakDynamicBytes does not match');
    }
    return plan;
  }
  const fields = [
    'bitDepth',
    'colorType',
    'height',
    'peakDynamicBytes',
    'rowBytes',
    'strategy',
    'width',
  ];
  const banded = strategy === 'png-band-v1';
  const record = exactRecord(value, banded ? [...fields, 'band'] : fields, 'PNG coupling plan');
  if (!banded && strategy !== 'png-whole-v1') {
    throw new Error('Coupling plan strategy is unsupported');
  }
  const geometry = {
    bitDepth: integer(record, 'bitDepth'),
    colorType: integer(record, 'colorType'),
    height: integer(record, 'height'),
    rowBytes: integer(record, 'rowBytes'),
    width: integer(record, 'width'),
  };
  const plan = banded
    ? createPngBandCouplingPlan({
        ...geometry,
        band: parseBandPlan(record.band),
        fileBytes,
      })
    : createPngWholeCouplingPlan({ ...geometry, fileBytes });
  if (integer(record, 'peakDynamicBytes') !== plan.peakDynamicBytes) {
    throw new Error('Coupling plan peakDynamicBytes does not match');
  }
  return plan;
}
