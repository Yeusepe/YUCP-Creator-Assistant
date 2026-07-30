import { describe, expect, it } from 'bun:test';
import {
  createMaterializationDispatchSignature,
  relayMaterializationDispatchOutbox,
  verifyMaterializationDispatchSignature,
} from './materializationDispatch';

describe('materialization dispatch outbox', () => {
  it('signs the timestamp and exact raw body', async () => {
    const body = new TextEncoder().encode(
      '{"jobs":[{"jobId":"job-a","traceId":"0123456789abcdef0123456789abcdef"}]}'
    );
    const secret = 'dispatch-secret-with-at-least-32-bytes';
    const timestamp = '1785326400';
    const signature = await createMaterializationDispatchSignature({
      body,
      secret,
      timestamp,
    });
    await expect(
      verifyMaterializationDispatchSignature({
        body,
        nowSeconds: Number(timestamp),
        secret,
        signature,
        timestamp,
      })
    ).resolves.toBeTrue();
    await expect(
      verifyMaterializationDispatchSignature({
        body: Uint8Array.of(...body, 0x20),
        nowSeconds: Number(timestamp),
        secret,
        signature,
        timestamp,
      })
    ).resolves.toBeFalse();
  });

  it('claims at most 100 rows and records only accepted dispatches', async () => {
    const claimed = Array.from({ length: 120 }, (_, index) => ({
      cacheAffinityKey: `${index}`.padStart(64, '0'),
      jobId: `job-${index}`,
      lane: 'large' as const,
      traceId: `${index}`.padStart(32, '0'),
    }));
    const accepted: string[] = [];
    const failed: Array<{ errorCode: string; jobId: string }> = [];
    const batches: number[] = [];

    const result = await relayMaterializationDispatchOutbox({
      dispatch: async (entries) => {
        batches.push(entries.length);
        return entries.map((entry, index) => ({
          accepted: index !== 2,
          ...(index === 2 ? { errorCode: 'dispatch_rejected' } : {}),
          jobId: entry.jobId,
        }));
      },
      repository: {
        claim: async (limit) => claimed.slice(0, limit),
        markAccepted: async (jobIds) => {
          accepted.push(...jobIds);
        },
        markFailed: async (entries) => {
          failed.push(...entries);
        },
      },
    });

    expect(batches).toEqual([100]);
    expect(result).toEqual({ accepted: 99, attempted: 100, failed: 1 });
    expect(accepted).toHaveLength(99);
    expect(failed).toEqual([{ errorCode: 'dispatch_rejected', jobId: 'job-2' }]);
  });

  it('returns every claimed row to retry immediately when dispatch transport fails', async () => {
    const claimed = [
      {
        cacheAffinityKey: 'a'.repeat(64),
        jobId: 'job-a',
        lane: 'large' as const,
        traceId: '1'.repeat(32),
      },
      {
        cacheAffinityKey: 'b'.repeat(64),
        jobId: 'job-b',
        lane: 'large' as const,
        traceId: '2'.repeat(32),
      },
    ];
    const failed: Array<{ errorCode: string; jobId: string }> = [];

    await expect(
      relayMaterializationDispatchOutbox({
        dispatch: async () => {
          throw new Error('network unavailable');
        },
        repository: {
          claim: async () => claimed,
          markAccepted: async () => {},
          markFailed: async (entries) => {
            failed.push(...entries);
          },
        },
      })
    ).rejects.toThrow('network unavailable');
    expect(failed).toEqual([
      { errorCode: 'dispatch_transport_failed', jobId: 'job-a' },
      { errorCode: 'dispatch_transport_failed', jobId: 'job-b' },
    ]);
  });
});
