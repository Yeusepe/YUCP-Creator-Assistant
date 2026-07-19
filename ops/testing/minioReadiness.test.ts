import { describe, expect, it } from 'bun:test';
import { waitForMinioReady } from './minioReadiness';

describe('waitForMinioReady', () => {
  it('retries HTTP 503 responses until MinIO reports ready', async () => {
    const requests: string[] = [];
    const retryDelays: number[] = [];
    let probeCount = 0;

    await waitForMinioReady({
      endpoint: 'http://127.0.0.1:9000',
      fetch: async (url) => {
        requests.push(url);
        probeCount += 1;
        return new Response(null, { status: probeCount < 3 ? 503 : 200 });
      },
      sleep: async (delay) => {
        retryDelays.push(delay);
      },
    });

    expect(requests).toEqual([
      'http://127.0.0.1:9000/minio/health/ready',
      'http://127.0.0.1:9000/minio/health/ready',
      'http://127.0.0.1:9000/minio/health/ready',
    ]);
    expect(retryDelays).toEqual([100, 200]);
  });
});
