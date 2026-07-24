import { describe, expect, mock, test } from 'bun:test';
import {
  createMaterializationControlClient,
  loadMaterializationControlClient,
} from './materializationControlClient';

const baseUrl = 'https://materialization.example.test';
const sharedSecret = 'api-materialization-secret-value';

describe('materialization control client', () => {
  test('creates and reads one durable job without exposing the service credential', async () => {
    const requests: Request[] = [];
    const fetchImplementation = mock(async (request: Request) => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith('/create')) {
        return Response.json({ jobId: 'job-1', status: 'queued' }, { status: 202 });
      }
      return Response.json({
        queuePosition: 1,
        state: 'QUEUED',
        status: 'pending',
      });
    });
    const client = createMaterializationControlClient({
      baseUrl,
      fetchImplementation,
      sharedSecret,
      timeoutMs: 1_000,
    });
    await client.createJob({
      bindingRoot: '22'.repeat(32),
      buyerId: 'buyer-1',
      creatorId: 'creator-1',
      grantJti: 'grant-1',
      jobId: 'job-1',
      productId: 'com.yucp.jammr',
      protectedFiles: [
        {
          materializerType: 'png',
          normalizedPath: 'Assets/Jammr/a.png',
          required: true,
          sourceSha256: '44'.repeat(32),
        },
      ],
      protectedSourceRoot: '33'.repeat(32),
      releaseRoot: '11'.repeat(32),
      sourceLogicalBytes: 100,
      sourceLogicalFiles: 1,
      sourceManifestSha256: '55'.repeat(32),
      sourceVersionId: '018f8c03-3880-7d40-a8d5-b190a64141cc',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    });
    await expect(client.getStatus({ grantJti: 'grant-1', jobId: 'job-1' })).resolves.toEqual({
      queuePosition: 1,
      state: 'QUEUED',
      status: 'pending',
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/v2/internal/materialization-jobs/create',
      '/v2/internal/materialization-jobs/status',
    ]);
    expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${sharedSecret}`);
    expect(requests[0]?.headers.get('traceparent')).toBe(
      '00-11111111111111111111111111111111-2222222222222222-01'
    );
    expect(JSON.stringify(await requests[0]?.clone().json())).not.toContain(sharedSecret);
  });

  test('lists bounded attribution candidates from the durable control plane', async () => {
    const requests: Request[] = [];
    const candidate = {
      algorithmVersion: 'png-dct-qim-v2',
      attributionId: 'attribution-1',
      attributionTokenHash: '66'.repeat(32),
      buyerSubjectPseudonym: Buffer.alloc(32, 0x77).toString('base64url'),
      capabilityId: 'capability-1',
      createdAt: 2_000_000_000_000,
      creatorId: 'creator-1',
      jobId: 'job-1',
      keyEpoch: 3,
      leaseGeneration: 2,
      materializerType: 'png' as const,
      normalizedPath: 'Assets/Jammr/a.png',
      outputFormat: 'zip' as const,
      pluginVersion: 'png-plugin-2',
      protectedSourceRoot: '33'.repeat(32),
      releaseRoot: '11'.repeat(32),
      sourceSha256: '44'.repeat(32),
    };
    const client = createMaterializationControlClient({
      baseUrl,
      fetchImplementation: mock(async (request: Request) => {
        requests.push(request);
        return Response.json({
          candidateLimit: 512,
          candidates: [candidate],
          truncated: false,
        });
      }),
      sharedSecret,
    });

    await expect(
      client.listAttributionCandidates({
        creatorId: 'creator-1',
        productId: 'com.yucp.jammr',
      })
    ).resolves.toEqual({
      candidateLimit: 512,
      candidates: [candidate],
      truncated: false,
    });
    expect(new URL(requests[0]?.url ?? '').pathname).toBe(
      '/v2/internal/materialization-attribution/candidates'
    );
    expect(await requests[0]?.clone().json()).toEqual({
      creatorId: 'creator-1',
      productId: 'com.yucp.jammr',
    });
  });

  test('fails closed on an invalid response or non-loopback HTTP origin', async () => {
    expect(() =>
      createMaterializationControlClient({
        baseUrl: 'http://materialization.example.test',
        sharedSecret,
      })
    ).toThrow('HTTPS');
    const client = createMaterializationControlClient({
      baseUrl: 'http://127.0.0.1:3012',
      fetchImplementation: async () =>
        Response.json({ jobId: 'different-job', status: 'queued' }, { status: 202 }),
      sharedSecret,
    });
    await expect(
      client.createJob({
        bindingRoot: '22'.repeat(32),
        buyerId: 'buyer-1',
        creatorId: 'creator-1',
        grantJti: 'grant-1',
        jobId: 'job-1',
        productId: 'com.yucp.jammr',
        protectedFiles: [
          {
            materializerType: 'png',
            normalizedPath: 'Assets/Jammr/a.png',
            required: true,
            sourceSha256: '44'.repeat(32),
          },
        ],
        protectedSourceRoot: '33'.repeat(32),
        releaseRoot: '11'.repeat(32),
        sourceLogicalBytes: 100,
        sourceLogicalFiles: 1,
        sourceManifestSha256: '55'.repeat(32),
        sourceVersionId: '018f8c03-3880-7d40-a8d5-b190a64141cc',
      })
    ).rejects.toThrow('invalid response');
  });

  test('requires the internal origin and credential together', () => {
    expect(
      loadMaterializationControlClient({
        MATERIALIZATION_API_SHARED_SECRET: undefined,
        MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL: undefined,
      })
    ).toBeNull();
    expect(() =>
      loadMaterializationControlClient({
        MATERIALIZATION_API_SHARED_SECRET: sharedSecret,
        MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL: undefined,
      })
    ).toThrow('configured together');
    expect(
      loadMaterializationControlClient({
        MATERIALIZATION_API_SHARED_SECRET: sharedSecret,
        MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL: 'http://127.0.0.1:3012',
      })
    ).not.toBeNull();
  });
});
