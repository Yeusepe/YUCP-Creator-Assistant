import { describe, expect, it } from 'bun:test';
import {
  createPeakMeasurementLifecycle,
  runMeasuredResourceLifecycle,
} from './measuredResourceLifecycle';

describe('measured resource lifecycle', () => {
  it('stops and joins resource sampling before cleanup while preserving the primary failure', async () => {
    const events: string[] = [];
    const primaryFailure = new Error('primary operation failed');
    const stopStarted = Promise.withResolvers<void>();
    const permitStop = Promise.withResolvers<void>();

    const execution = runMeasuredResourceLifecycle({
      cleanup: async () => {
        events.push('cleanup');
      },
      run: async () => {
        events.push('run');
        throw primaryFailure;
      },
      stopMeasurement: async () => {
        events.push('stop-started');
        stopStarted.resolve();
        await permitStop.promise;
        events.push('stop-complete');
        return 17;
      },
    });

    await stopStarted.promise;
    expect(events).toEqual(['run', 'stop-started']);

    permitStop.resolve();
    await expect(execution).rejects.toBe(primaryFailure);
    expect(events).toEqual(['run', 'stop-started', 'stop-complete', 'cleanup']);
  });

  it('releases expanded phase trees after immutable metadata capture without hiding peak usage', async () => {
    const events: string[] = [];
    const expandedTrees = new Set(['expected-v1', 'retrieved-v1']);
    const retainedMetadata = Object.freeze([
      Object.freeze({
        bytes: 17,
        normalizedPath: 'Assets/Product/model.fbx',
        sha256: 'a'.repeat(64),
      }),
    ]);
    const phasePeaks = [21, 34, 13];
    let session = 0;
    let activeSample = Promise.resolve();
    const measurement = createPeakMeasurementLifecycle(() => {
      const current = session++;
      events.push(`sample-${current}-start`);
      activeSample = Promise.resolve().then(() => {
        events.push(`sample-${current}-joined`);
      });
      return {
        stop: async () => {
          events.push(`sample-${current}-stop`);
          await activeSample;
          return phasePeaks[current] ?? 0;
        },
      };
    });

    await measurement.releaseResources(async () => {
      events.push('release-expected');
      expandedTrees.delete('expected-v1');
    });
    expect(expandedTrees.has('expected-v1')).toBeFalse();
    expect(retainedMetadata[0]?.sha256).toBe('a'.repeat(64));

    await measurement.releaseResources(async () => {
      events.push('release-reconstructed');
      expandedTrees.delete('retrieved-v1');
    });
    expect(expandedTrees).toEqual(new Set());
    expect(await measurement.stop()).toBe(34);
    expect(events.indexOf('sample-0-stop')).toBeLessThan(events.indexOf('release-expected'));
    expect(events.indexOf('sample-0-joined')).toBeLessThan(events.indexOf('release-expected'));
    expect(events.indexOf('sample-1-stop')).toBeLessThan(events.indexOf('release-reconstructed'));
    expect(events.indexOf('sample-1-joined')).toBeLessThan(events.indexOf('release-reconstructed'));
    expect(events.at(-1)).toBe('sample-2-stop');
  });

  it('retains primary and cleanup failures in lifecycle order', async () => {
    const primaryFailure = new Error('primary operation failed');
    const cleanupFailure = new Error('cleanup failed');

    try {
      await runMeasuredResourceLifecycle({
        cleanup: async () => {
          throw cleanupFailure;
        },
        run: async () => {
          throw primaryFailure;
        },
        stopMeasurement: async () => 0,
      });
      throw new Error('Expected the measured lifecycle to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([primaryFailure, cleanupFailure]);
    }
  });
});
