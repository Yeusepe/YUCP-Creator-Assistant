import { describe, expect, it } from 'bun:test';

import {
  COUPLING_DYNAMIC_BUDGET_BYTES,
  createFbxCouplingPlan,
  createPngBandCouplingPlan,
  createPngWholeCouplingPlan,
} from './couplingPlan';

describe('delivery manifest v5 coupling planner', () => {
  it('produces the same explicit band peak used by the Worker', () => {
    const plan = createPngBandCouplingPlan({
      band: {
        idatPrefixCrc32: 1,
        idatSuffixCrc32: 2,
        idatSuffixLength: 3,
        length: 4,
        offset: 5,
        prefixAdler: 6,
        rows: 256,
        suffixAdler: 7,
        suffixFilteredLength: 8,
        y0: 0,
      },
      bitDepth: 8,
      colorType: 2,
      fileBytes: 27_852_566,
      height: 8192,
      rowBytes: 8192 * 3,
      width: 8192,
    });
    expect(plan.strategy).toBe('png-band-v1');
    expect(plan.peakDynamicBytes).toBeLessThanOrEqual(COUPLING_DYNAMIC_BUDGET_BYTES);
  });

  it('fails ingest preflight for unsupported or over-budget assets', () => {
    expect(() => createFbxCouplingPlan(8 * 1024 * 1024 + 1)).toThrow();
    expect(() =>
      createPngWholeCouplingPlan({
        bitDepth: 8,
        colorType: 6,
        fileBytes: 8 * 1024 * 1024,
        height: 4096,
        rowBytes: 4096 * 4,
        width: 4096,
      })
    ).toThrow('dynamic budget');
  });
});
