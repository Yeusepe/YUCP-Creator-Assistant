import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  apiPostMock,
  findPreviousUploadsMock,
  resumeFromPreviousUploadMock,
  spanEndMock,
  spanFailMock,
  startSpanMock,
  uploadOptionsMock,
  uploadStartMock,
} = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  findPreviousUploadsMock: vi.fn(),
  resumeFromPreviousUploadMock: vi.fn(),
  spanEndMock: vi.fn(),
  spanFailMock: vi.fn(),
  startSpanMock: vi.fn(),
  uploadOptionsMock: vi.fn(),
  uploadStartMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { post: apiPostMock },
}));

vi.mock('@/lib/hyperdx', () => ({
  startHyperdxBrowserSpan: startSpanMock,
}));

vi.mock('tus-js-client', () => ({
  Upload: class {
    constructor(_file: File, options: unknown) {
      uploadOptionsMock(options);
    }

    findPreviousUploads = findPreviousUploadsMock;
    resumeFromPreviousUpload = resumeFromPreviousUploadMock;
    start = uploadStartMock;
  },
}));

import { normalizeUploadError, uploadPackageFile } from '@/lib/upload';

describe('upload telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiPostMock.mockResolvedValue({
      versionId: 'version-sensitive',
      exp: '123',
      sig: 'secret',
      tusEndpoint: 'https://ingest.test/files',
      headers: {},
      protectionPolicyId: 'supported-visual-assets-v2',
    });
    findPreviousUploadsMock.mockResolvedValue([]);
    startSpanMock.mockReturnValue({ end: spanEndMock, fail: spanFailMock });
  });

  it('records upload size without package or version identifiers', async () => {
    const file = new File(['payload'], 'package.zip', { type: 'application/zip' });

    await uploadPackageFile({
      file,
      packageId: 'package-sensitive',
      version: '1.2.3-sensitive',
    });

    expect(startSpanMock).toHaveBeenCalledWith('creator.upload', { byteSize: file.size });
    expect(apiPostMock).toHaveBeenCalledWith('/api/creator/uploads/authorize', {
      editionId: 'standard',
      packageId: 'package-sensitive',
      version: '1.2.3-sensitive',
    });
    expect(uploadOptionsMock.mock.calls[0]?.[0]).toMatchObject({
      metadata: {
        protectionPolicyId: 'supported-visual-assets-v2',
      },
    });
  });

  it('resumes the matching previous tus upload before starting transfer', async () => {
    const previousUpload = { uploadUrl: 'https://ingest.test/files/upload-1' };
    findPreviousUploadsMock.mockResolvedValue([previousUpload]);

    await uploadPackageFile({
      editionId: 'commercial',
      file: new File(['payload'], 'package.zip', { type: 'application/zip' }),
      packageId: 'package-sensitive',
      version: '1.2.3',
    });

    expect(findPreviousUploadsMock).toHaveBeenCalledOnce();
    expect(resumeFromPreviousUploadMock).toHaveBeenCalledWith(previousUpload);
    expect(resumeFromPreviousUploadMock.mock.invocationCallOrder[0]).toBeLessThan(
      uploadStartMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it('scopes resumable upload fingerprints to the authorized logical version and file', async () => {
    const file = new File(['payload'], 'package.zip', {
      lastModified: 1_753_488_000_000,
      type: 'application/zip',
    });

    await uploadPackageFile({
      editionId: 'commercial',
      file,
      packageId: 'package-sensitive',
      version: '1.2.3',
    });

    const options = uploadOptionsMock.mock.calls[0]?.[0] as {
      fingerprint?: (candidate: File) => Promise<string>;
    };
    expect(options.fingerprint).toBeTypeOf('function');
    await expect(options.fingerprint?.(file)).resolves.toBe(
      `yucp-version-sensitive-package.zip-${file.size}-1753488000000`
    );
  });

  it('turns a duplicate tus response into useful package guidance', () => {
    const error = Object.assign(new Error('tus: unexpected response'), {
      originalResponse: {
        getStatus: () => 409,
      },
    });

    expect(normalizeUploadError(error).message).toBe(
      'This package version already exists or is still being prepared. Wait for it to finish, or use a new version.'
    );
  });

  it('does not infer a duplicate response from backend implementation text', () => {
    const error = new Error(
      'tus: unexpected response: duplicate key value violates unique constraint'
    );

    expect(normalizeUploadError(error).message).toBe(
      'The package upload was interrupted. Your draft is safe. Check your connection and try again.'
    );
  });
});
