import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiPostMock, createdUploads } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  createdUploads: [] as Array<{
    file: File;
    url: string | null;
    options: {
      endpoint?: string | null;
      metadata?: Record<string, string>;
      chunkSize?: number;
      retryDelays?: number[] | null;
      removeFingerprintOnSuccess?: boolean;
      onProgress?: ((bytesSent: number, bytesTotal: number) => void) | null;
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
    readonly url = 'https://ingest.test/files/job_123';

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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

  it('authorizes and uploads with tus, then polls processing until the signed result completes', async () => {
    apiPostMock.mockResolvedValueOnce(authorization);
    const file = new File(['package bytes'], 'bundle.zip', { type: 'application/zip' });
    const onProgress = vi.fn();
    const onProcessing = vi.fn();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ state: 'processing' }))
      .mockResolvedValueOnce(Response.json({ state: 'completed', result: 'signed-ingest-result' }));
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = uploadBackstageReleaseSource({
      packageId: 'com.yucp.bundle',
      file,
      version: '1.2.3',
      deliveryName: 'release.zip',
      onProgress,
      onProcessing,
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
      },
      { signal: undefined }
    );
    expect(apiPostMock.mock.calls[0]?.[1]).not.toHaveProperty('materializeMetadata');

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

    vi.useFakeTimers();
    upload.options.onSuccess?.({ lastResponse: {} });
    expect(onProcessing).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toEqual({
      ingestResult: 'signed-ingest-result',
      version: '1.2.3',
      deliveryName: 'release.zip',
      sourceContentType: 'application/zip',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://ingest.test/jobs/job_123');
      expect(init?.headers).toEqual({ Authorization: 'Bearer signed-upload-token' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('retries a timed-out ingest job poll and accepts a later completed result', async () => {
    apiPostMock.mockResolvedValueOnce(authorization);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new DOMException('The operation timed out', 'TimeoutError'))
      .mockResolvedValueOnce(Response.json({ state: 'completed', result: 'signed-ingest-result' }));
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = uploadBackstageReleaseSource({
      packageId: 'com.yucp.bundle',
      file: new File(['package bytes'], 'bundle.zip'),
      version: '1.2.3',
    });

    await vi.waitFor(() => expect(createdUploads).toHaveLength(1));
    vi.useFakeTimers();
    createdUploads[0].options.onSuccess?.({ lastResponse: {} });
    const resultExpectation = expect(resultPromise).resolves.toMatchObject({
      ingestResult: 'signed-ingest-result',
    });

    await vi.advanceTimersByTimeAsync(1000);
    await resultExpectation;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://ingest.test/jobs/job_123');
      expect(init?.headers).toEqual({ Authorization: 'Bearer signed-upload-token' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('rejects when the ingest job reports a failed state', async () => {
    apiPostMock.mockResolvedValueOnce(authorization);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ state: 'failed', reason: 'materialize_failed' }));
    vi.stubGlobal('fetch', fetchMock);
    const resultPromise = uploadBackstageReleaseSource({
      packageId: 'com.yucp.bundle',
      file: new File(['package bytes'], 'bundle.zip'),
      version: '1.2.3',
    });

    await vi.waitFor(() => expect(createdUploads).toHaveLength(1));
    createdUploads[0].options.onSuccess?.({ lastResponse: {} });

    await expect(resultPromise).rejects.toThrow('materialize_failed');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ingest.test/jobs/job_123');
    expect(init?.headers).toEqual({ Authorization: 'Bearer signed-upload-token' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
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
