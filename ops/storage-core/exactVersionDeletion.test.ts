import { afterEach, describe, expect, it, mock } from 'bun:test';
import { loadCasConfig } from './config';
import { createExactVersionDeletionPort } from './exactVersionDeletion';

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

function port() {
  return createExactVersionDeletionPort({
    common: config('yucp-common'),
    metadata: config('yucp-metadata'),
    protected: config('yucp-protected'),
  });
}

describe('S3 exact-version deletion', () => {
  it('deletes an ETag-identified version with a plain DELETE', async () => {
    const etag = '9b2cf535f27731c974343645a3985328';
    let request: Request | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      request = new Request(input);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await port().deleteExactVersion({
      fileIdentifier: etag,
      objectKey: 'v2/common/chunks/aa/digest',
      providerVersion: etag,
      role: 'common',
    });

    expect(request?.method).toBe('DELETE');
    const url = new URL(request?.url ?? '');
    expect(url.pathname).toBe('/yucp-common/v2/common/chunks/aa/digest');
    expect(url.searchParams.has('versionId')).toBeFalse();
  });

  it('rejects an empty provider version instead of deleting the whole key', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('Unexpected provider call');
    }) as unknown as typeof fetch;

    await expect(
      port().deleteExactVersion({
        fileIdentifier: ' ',
        objectKey: 'v2/common/chunks/aa/digest',
        providerVersion: ' ',
        role: 'common',
      })
    ).rejects.toThrow('must not be empty');
  });
});
