import { afterEach, describe, expect, it, mock } from 'bun:test';
import { loadCasConfig } from './config';
import {
  copyS3ObjectVersion,
  deleteS3ObjectVersion,
  getS3ObjectRetention,
  resolveSignedRequestTimeoutMs,
} from './s3Control';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function config(bucket: string) {
  return loadCasConfig({
    CAS_S3_ACCESS_KEY_ID: 'test-access',
    CAS_S3_BUCKET: bucket,
    CAS_S3_ENDPOINT: 'https://s3.example.test',
    CAS_S3_REGION: 'us-east-1',
    CAS_S3_SECRET_ACCESS_KEY: 'test-secret',
  });
}

describe('S3 exact version operations', () => {
  it('copies one named source version and returns the destination version', async () => {
    let request: Request | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      request = new Request(input);
      return new Response('<CopyObjectResult><ETag>"etag"</ETag></CopyObjectResult>', {
        headers: {
          'x-amz-copy-source-version-id': 'source-version',
          'x-amz-version-id': 'destination-version',
        },
      });
    }) as unknown as typeof fetch;

    const result = await copyS3ObjectVersion({
      destination: config('common'),
      destinationKey: 'v2/common/chunks/abcd',
      source: config('quarantine'),
      sourceKey: 'candidates/chunk',
      sourceVersionId: 'source-version',
    });

    expect(result.versionId).toBe('destination-version');
    expect(request?.headers.get('x-amz-copy-source')).toBe(
      '/quarantine/candidates/chunk?versionId=source-version'
    );
  });

  it('deletes only the requested provider version', async () => {
    let request: Request | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      request = new Request(input);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await deleteS3ObjectVersion(config('common'), 'v2/common/chunks/abcd', 'version-to-delete');

    expect(request?.method).toBe('DELETE');
    expect(new URL(request?.url ?? '').searchParams.get('versionId')).toBe('version-to-delete');
  });

  it('reads retention for the requested provider version', async () => {
    let request: Request | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      request = new Request(input);
      return new Response(
        '<Retention><Mode>GOVERNANCE</Mode>' +
          '<RetainUntilDate>2026-08-01T00:00:00.000Z</RetainUntilDate></Retention>'
      );
    }) as unknown as typeof fetch;

    const retention = await getS3ObjectRetention(
      config('common'),
      'v2/common/chunks/abcd',
      'version-retained'
    );

    expect(retention).toEqual({
      mode: 'GOVERNANCE',
      retainUntil: new Date('2026-08-01T00:00:00.000Z'),
    });
    const url = new URL(request?.url ?? '');
    expect(url.searchParams.get('versionId')).toBe('version-retained');
    expect(url.searchParams.has('retention')).toBeTrue();
  });
});

describe('signed request deadlines', () => {
  it('keeps the configured deadline for bodyless control-plane calls', () => {
    expect(resolveSignedRequestTimeoutMs(30_000, undefined)).toBe(30_000);
  });

  it('grants a large body time proportional to its size', () => {
    const small = resolveSignedRequestTimeoutMs(30_000, new Uint8Array(1024 * 1024));
    const large = resolveSignedRequestTimeoutMs(30_000, new Uint8Array(16 * 1024 * 1024));

    expect(small).toBeGreaterThan(30_000);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThan(15 * 60 * 1000);
  });

  it('caps the deadline so a stalled transfer cannot hang forever', () => {
    const body = new Uint8Array(4 * 1024 * 1024 * 1024);

    expect(resolveSignedRequestTimeoutMs(30_000, body)).toBe(15 * 60 * 1000);
  });
});
