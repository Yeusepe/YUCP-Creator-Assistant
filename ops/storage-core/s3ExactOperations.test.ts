import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { loadCasConfig } from './config';
import {
  copyS3ObjectVersion,
  deleteS3ObjectVersion,
  getS3ObjectRetention,
  getS3ObjectVersion,
  headS3ObjectVersion,
  putS3ObjectVersioned,
  resolveSignedRequestTimeoutMs,
  throttleRetryDelayMs,
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
  it('copies an ETag-pinned source and returns the destination ETag identity', async () => {
    const destinationEtag = 'b1946ac92492d2347c6235b4d2611184';
    let request: Request | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      request = new Request(input);
      return new Response(
        `<CopyObjectResult><ETag>"${destinationEtag}"</ETag></CopyObjectResult>`,
        { headers: { 'x-amz-version-id': 'destination-version' } }
      );
    }) as unknown as typeof fetch;

    const sourceEtag = '9b2cf535f27731c974343645a3985328';
    const result = await copyS3ObjectVersion({
      destination: config('common'),
      destinationKey: 'v2/common/chunks/abcd',
      source: config('quarantine'),
      sourceKey: 'candidates/chunk',
      sourceVersionId: sourceEtag,
    });

    expect(result.versionId).toBe(destinationEtag);
    expect(request?.headers.get('x-amz-copy-source')).toBe('/quarantine/candidates/chunk');
    expect(request?.headers.get('x-amz-copy-source-if-match')).toBe(`"${sourceEtag}"`);
  });

  it('deletes the exact version with a plain DELETE', async () => {
    let request: Request | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      request = new Request(input);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await deleteS3ObjectVersion(
      config('common'),
      'v2/common/chunks/abcd',
      '9b2cf535f27731c974343645a3985328'
    );

    expect(request?.method).toBe('DELETE');
    expect(new URL(request?.url ?? '').searchParams.has('versionId')).toBeFalse();
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

describe('S3 exact ETag versions without provider versioning', () => {
  const body = Uint8Array.from([7, 6, 5]);
  const bodyMd5 = createHash('md5').update(body).digest('hex');
  const digest = createHash('sha256').update(body).digest('hex');

  it('mints the write ETag as the exact version and verifies it against the body MD5', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(null, { headers: { etag: `"${bodyMd5}"` } });
    }) as unknown as typeof fetch;

    const result = await putS3ObjectVersioned({
      body,
      config: config('metadata'),
      contentType: 'application/json',
      key: 'v2/metadata/etag-write.json',
    });

    expect(result).toEqual({
      bytes: body.byteLength,
      fileIdentifier: bodyMd5,
      sha256: digest,
      versionId: bodyMd5,
    });
  });

  it('rejects a write whose ETag does not match the body MD5', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(null, { headers: { etag: '"dddddddddddddddddddddddddddddddd"' } });
    }) as unknown as typeof fetch;

    await expect(
      putS3ObjectVersioned({
        body,
        config: config('metadata'),
        contentType: 'application/json',
        key: 'v2/metadata/etag-mismatch.json',
      })
    ).rejects.toThrow('does not match the body MD5');
  });

  it('rejects a write that reports neither a version id nor an ETag', async () => {
    globalThis.fetch = mock(async () => new Response(null)) as unknown as typeof fetch;

    await expect(
      putS3ObjectVersioned({
        body,
        config: config('metadata'),
        contentType: 'application/json',
        key: 'v2/metadata/etag-missing.json',
      })
    ).rejects.toThrow('omitted its exact version identifier');
  });

  it('heads an ETag version with If-Match and no versionId query', async () => {
    let request: Request | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      request = new Request(input);
      return new Response(null, {
        headers: {
          'content-length': String(body.byteLength),
          'content-type': 'application/octet-stream',
          etag: `"${bodyMd5}"`,
          'x-amz-meta-yucp-sha256': digest,
        },
      });
    }) as unknown as typeof fetch;

    const head = await headS3ObjectVersion(config('common'), 'v2/common/chunks/abcd', bodyMd5);

    expect(head.fileIdentifier).toBe(bodyMd5);
    expect(head.versionId).toBe(bodyMd5);
    expect(head.contentLength).toBe(body.byteLength);
    expect(head.metadata['yucp-sha256']).toBe(digest);
    expect(request?.method).toBe('HEAD');
    expect(request?.headers.get('if-match')).toBe(`"${bodyMd5}"`);
    expect(new URL(request?.url ?? '').searchParams.has('versionId')).toBeFalse();
  });

  it('treats a changed object as a missing exact version on a 412 read', async () => {
    globalThis.fetch = mock(
      async () => new Response(null, { status: 412 })
    ) as unknown as typeof fetch;

    await expect(
      getS3ObjectVersion(config('common'), 'v2/common/chunks/abcd', bodyMd5)
    ).rejects.toThrow('HTTP status 412');
  });

  it('rejects an ETag read whose returned ETag differs from the requested version', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(body, { headers: { etag: '"dddddddddddddddddddddddddddddddd"' } });
    }) as unknown as typeof fetch;

    await expect(
      getS3ObjectVersion(config('common'), 'v2/common/chunks/abcd', bodyMd5)
    ).rejects.toThrow('different object version');
  });

  it('deletes an ETag version with a plain DELETE', async () => {
    let request: Request | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      request = new Request(input);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await deleteS3ObjectVersion(config('common'), 'v2/common/chunks/abcd', bodyMd5);

    expect(request?.method).toBe('DELETE');
    expect(new URL(request?.url ?? '').searchParams.has('versionId')).toBeFalse();
  });

  it('copies an ETag-pinned source and returns the destination ETag version', async () => {
    let request: Request | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      request = new Request(input);
      return new Response(`<CopyObjectResult><ETag>"${bodyMd5}"</ETag></CopyObjectResult>`);
    }) as unknown as typeof fetch;

    const result = await copyS3ObjectVersion({
      destination: config('common'),
      destinationKey: 'v2/common/chunks/abcd',
      source: config('quarantine'),
      sourceKey: 'candidates/chunk',
      sourceVersionId: bodyMd5,
    });

    expect(result).toEqual({ fileIdentifier: bodyMd5, versionId: bodyMd5 });
    expect(request?.headers.get('x-amz-copy-source')).toBe('/quarantine/candidates/chunk');
    expect(request?.headers.get('x-amz-copy-source-if-match')).toBe(`"${bodyMd5}"`);
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

  it('grants a large expected download the same size-proportional deadline', () => {
    const large = resolveSignedRequestTimeoutMs(30_000, undefined, 293 * 1024 * 1024);

    expect(large).toBeGreaterThan(30_000);
    expect(resolveSignedRequestTimeoutMs(30_000, undefined, 0)).toBe(30_000);
    expect(resolveSignedRequestTimeoutMs(30_000, undefined, 8 * 1024 * 1024 * 1024)).toBe(
      15 * 60 * 1000
    );
  });
});

describe('signed request retries', () => {
  it('retries a timed-out provider call instead of failing the operation', async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
      }
      return new Response(null, {
        headers: { etag: `"${createHash('md5').update(Uint8Array.from([7, 7, 7])).digest('hex')}"` },
      });
    }) as unknown as typeof fetch;

    const result = await putS3ObjectVersioned({
      body: Uint8Array.from([7, 7, 7]),
      config: config('metadata'),
      contentType: 'application/json',
      key: 'v2/metadata/retry-after-stall.json',
    });

    expect(calls).toBe(2);
    expect(result.versionId).toBe(createHash('md5').update(Uint8Array.from([7, 7, 7])).digest('hex'));
  });

  it('retries a throttled response and gives up with its status', async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return new Response(null, { headers: { 'retry-after': '0' }, status: 503 });
    }) as unknown as typeof fetch;

    await expect(
      putS3ObjectVersioned({
        body: Uint8Array.from([1]),
        config: config('metadata'),
        contentType: 'application/json',
        key: 'v2/metadata/throttled.json',
      })
    ).rejects.toThrow('HTTP status 503');
    expect(calls).toBe(6);
  });

  it('waits out a throttle window and succeeds once the provider recovers', async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls <= 4) {
        return new Response(null, { headers: { 'retry-after': '0' }, status: 503 });
      }
      return new Response(null, {
        headers: { etag: `"${createHash('md5').update(Uint8Array.from([1])).digest('hex')}"` },
      });
    }) as unknown as typeof fetch;

    const result = await putS3ObjectVersioned({
      body: Uint8Array.from([1]),
      config: config('metadata'),
      contentType: 'application/json',
      key: 'v2/metadata/throttle-recovery.json',
    });

    expect(calls).toBe(5);
    expect(result.versionId).toBe(createHash('md5').update(Uint8Array.from([1])).digest('hex'));
  });

  it('does not retry a client error', async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return new Response(null, { status: 403 });
    }) as unknown as typeof fetch;

    await expect(
      putS3ObjectVersioned({
        body: Uint8Array.from([1]),
        config: config('metadata'),
        contentType: 'application/json',
        key: 'v2/metadata/forbidden.json',
      })
    ).rejects.toThrow('HTTP status 403');
    expect(calls).toBe(1);
  });
});

describe('throttle retry delays', () => {
  it('honors the provider Retry-After window instead of its own backoff', () => {
    expect(throttleRetryDelayMs(1, 5_000, () => 0)).toBe(5_000);
    expect(throttleRetryDelayMs(4, 5_000, () => 0)).toBe(5_000);
  });

  it('starts exponential backoff at one second when Retry-After is absent', () => {
    expect(throttleRetryDelayMs(1, undefined, () => 1)).toBe(1_000);
    expect(throttleRetryDelayMs(3, undefined, () => 1)).toBe(4_000);
  });

  it('caps the delay so retries cannot stall a request indefinitely', () => {
    expect(throttleRetryDelayMs(10, undefined, () => 1)).toBe(30_000);
    expect(throttleRetryDelayMs(1, 600_000, () => 0)).toBe(30_000);
  });
});
