import { describe, expect, it } from 'bun:test';
import {
  EXTERNAL_INTEGRATION_GATE_STEPS,
  PRODUCTION_REGRESSION_SURFACES,
  regressionPathExists,
} from './production-regression-loop';

describe('production-regression-loop', () => {
  it('locks the repo to the expected production incident surfaces', () => {
    expect(PRODUCTION_REGRESSION_SURFACES.map((surface) => surface.id)).toEqual([
      'provider',
      'attestation',
      'identity',
      'verification',
      'account',
      'backfill',
    ]);
  });

  it('requires every surface to declare concrete regression homes that exist in the repo', () => {
    for (const surface of PRODUCTION_REGRESSION_SURFACES) {
      expect(surface.invariant.length).toBeGreaterThan(20);
      expect(surface.primaryRegressionHomes.length).toBeGreaterThan(0);
      expect(surface.secondaryRegressionHomes.length).toBeGreaterThan(0);
      expect(surface.remediationHomes.length).toBeGreaterThan(0);

      for (const relativePath of [
        ...surface.primaryRegressionHomes,
        ...surface.secondaryRegressionHomes,
        ...surface.remediationHomes,
      ]) {
        expect(regressionPathExists(relativePath)).toBe(true);
      }
    }
  });

  it('keeps the external integration gate mapped to every production incident surface', () => {
    const coveredSurfaces = new Set(
      EXTERNAL_INTEGRATION_GATE_STEPS.flatMap((step) => step.covers)
    );

    for (const surface of PRODUCTION_REGRESSION_SURFACES) {
      expect(coveredSurfaces.has(surface.id)).toBe(true);
    }
  });
});
