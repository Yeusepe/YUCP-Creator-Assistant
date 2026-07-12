import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiPostMock, createdUploads } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  createdUploads: [] as Array<{
    file: File;
    options: {
      endpoint?: string | null;
      metadata?: Record<string, string>;
      chunkSize?: number;
      retryDelays?: number[] | null;
      removeFingerprintOnSuccess?: boolean;
      onProgress?: ((bytesSent: number, bytesTotal: number) => void) | null;
      onAfterResponse?:
        | ((request: unknown, response: { getHeader(name: string): string | undefined }) => void)
        | null;
      onSuccess?: ((payload: { lastResponse: unknown }) => void) | null;
      onError?: ((error: Error) => void) | null;
    };
    start: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@/api/client', () => ({
  apiClient: {
    post: apiPostMock,
  },
}));

vi.mock('tus-js-client', () => ({
  Upload: class MockTusUpload {
    readonly start = vi.fn();
    readonly abort = vi.fn(() => Promise.resolve());

    constructor(
      readonly file: File,
      readonly options: (typeof createdUploads)[number]['options']
    ) {
      createdUploads.push(this);
    }
  },
}));

import { uploadBackstageReleaseSource } from '@/lib/packages';

const authorization = {
  tusEndpoint: 'https://ingest.test/files',
  uploadToken: 'signed-upload-token',
  uploadMetadataKey: 'uploadToken',
  maxByteSize: 5 * 1024 * 1024 * 1024,
};

beforeEach(() => {
  apiPostMock.mockReset();
  createdUploads.length = 0;
});

describe('uploadBackstageReleaseSource', () => {
  it('rejects an already-aborted upload before hashing or authorization', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadBackstageReleaseSource({
        packageId: 'com.yucp.bundle',
        file: new File(['package bytes'], 'bundle.zip'),
        version: '1.2.3',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(apiPostMock).not.toHaveBeenCalled();
    expect(createdUploads).toHaveLength(0);
  });

  it('authorizes and uploads with tus, then returns the signed ingest result header', async () => {
    apiPostMock.mockResolvedValueOnce(authorization);
    const file = new File(['package bytes'], 'bundle.zip', { type: 'application/zip' });
    const onProgress = vi.fn();

    const resultPromise = uploadBackstageReleaseSource({
      packageId: 'com.yucp.bundle',
      file,
      version: '1.2.3',
      deliveryName: 'release.zip',
      materializeMetadata: {
        displayName: 'Bundle',
        metadata: { channel: 'stable' },
      },
      onProgress,
    });

    await vi.waitFor(() => expect(createdUploads).toHaveLength(1));
    expect(apiPostMock).toHaveBeenCalledWith(
      '/api/packages/com.yucp.bundle/backstage/upload-authorization',
      {
        version: '1.2.3',
        deliveryName: 'release.zip',
        sourceContentType: 'application/zip',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        byteSize: file.size,
        materializeMetadata: {
          displayName: 'Bundle',
          metadata: { channel: 'stable' },
        },
      },
      { signal: undefined }
    );

    const upload = createdUploads[0];
    expect(upload.file).toBe(file);
    expect(upload.options).toMatchObject({
      endpoint: authorization.tusEndpoint,
      metadata: { uploadToken: authorization.uploadToken },
      chunkSize: 64 * 1024 * 1024,
      retryDelays: [0, 1000, 3000, 5000],
      removeFingerprintOnSuccess: true,
    });
    expect(upload.start).toHaveBeenCalledOnce();

    upload.options.onProgress?.(32, 128);
    expect(onProgress).toHaveBeenCalledWith({ loaded: 32, total: 128 });

    upload.options.onAfterResponse?.(
      {},
      {
        getHeader: (name) =>
          name === 'X-Backstage-Ingest-Result' ? 'superseded-ingest-result' : undefined,
      }
    );
    upload.options.onAfterResponse?.(
      {},
      {
        getHeader: (name) =>
          name === 'X-Backstage-Ingest-Result' ? 'signed-ingest-result' : undefined,
      }
    );
    upload.options.onAfterResponse?.({}, { getHeader: () => undefined });
    upload.options.onSuccess?.({ lastResponse: {} });

    await expect(resultPromise).resolves.toEqual({
      ingestResult: 'signed-ingest-result',
      version: '1.2.3',
      deliveryName: 'release.zip',
      sourceContentType: 'application/zip',
    });
  });

  it('rejects a completed upload when the ingest result header is missing', async () => {
    apiPostMock.mockResolvedValueOnce(authorization);
    const resultPromise = uploadBackstageReleaseSource({
      packageId: 'com.yucp.bundle',
      file: new File(['package bytes'], 'bundle.zip'),
      version: '1.2.3',
    });

    await vi.waitFor(() => expect(createdUploads).toHaveLength(1));
    createdUploads[0].options.onSuccess?.({ lastResponse: {} });

    await expect(resultPromise).rejects.toThrow('Ingest service did not return a signed result');
  });

  it('aborts the tus upload when the caller signal is aborted', async () => {
    apiPostMock.mockResolvedValueOnce(authorization);
    const controller = new AbortController();
    const resultPromise = uploadBackstageReleaseSource({
      packageId: 'com.yucp.bundle',
      file: new File(['package bytes'], 'bundle.zip'),
      version: '1.2.3',
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(createdUploads).toHaveLength(1));
    expect(apiPostMock).toHaveBeenCalledWith(
      '/api/packages/com.yucp.bundle/backstage/upload-authorization',
      expect.any(Object),
      { signal: controller.signal }
    );
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(createdUploads[0].abort).toHaveBeenCalledOnce();
  });
});
