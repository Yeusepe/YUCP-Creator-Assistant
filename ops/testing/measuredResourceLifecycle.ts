export interface MeasuredResourceLifecycleInput<Result, Measurement> {
  cleanup: () => Promise<void>;
  run: () => Promise<Result>;
  stopMeasurement: () => Promise<Measurement>;
}

export interface MeasuredResourceLifecycleResult<Result, Measurement> {
  measurement: Measurement;
  result: Result;
}

export interface PeakMeasurementSession {
  stop: () => Promise<number>;
}

export interface PeakMeasurementLifecycle {
  releaseResources: (release: () => Promise<void>) => Promise<void>;
  stop: () => Promise<number>;
}

export function createPeakMeasurementLifecycle(
  startMeasurement: () => PeakMeasurementSession
): PeakMeasurementLifecycle {
  let active = startMeasurement();
  let peak = 0;
  let stopped = false;
  let transitioning = false;

  const joinActiveMeasurement = async () => {
    const measured = await active.stop();
    if (!Number.isSafeInteger(measured) || measured < 0) {
      throw new Error('Resource measurement returned an invalid peak');
    }
    peak = Math.max(peak, measured);
  };

  return {
    releaseResources: async (release) => {
      if (stopped || transitioning) {
        throw new Error('Resource measurement lifecycle is not available for release');
      }
      transitioning = true;
      try {
        await joinActiveMeasurement();
        try {
          await release();
        } finally {
          active = startMeasurement();
        }
      } finally {
        transitioning = false;
      }
    },
    stop: async () => {
      if (stopped || transitioning) {
        throw new Error('Resource measurement lifecycle cannot stop in its current state');
      }
      transitioning = true;
      try {
        await joinActiveMeasurement();
        stopped = true;
        return peak;
      } finally {
        transitioning = false;
      }
    },
  };
}

export async function runMeasuredResourceLifecycle<Result, Measurement>(
  input: MeasuredResourceLifecycleInput<Result, Measurement>
): Promise<MeasuredResourceLifecycleResult<Result, Measurement>> {
  let result!: Result;
  let measurement!: Measurement;
  let runFailure: unknown;
  let measurementFailure: unknown;
  let cleanupFailure: unknown;

  try {
    result = await input.run();
  } catch (error) {
    runFailure = error;
  }

  try {
    measurement = await input.stopMeasurement();
  } catch (error) {
    measurementFailure = error;
  }

  try {
    await input.cleanup();
  } catch (error) {
    cleanupFailure = error;
  }

  const failures = [runFailure, measurementFailure, cleanupFailure].filter(
    (failure) => failure !== undefined
  );
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Measured resource lifecycle failed');
  }

  return { measurement, result };
}
