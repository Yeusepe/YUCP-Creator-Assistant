import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiPostMock, spanEndMock, spanFailMock, startSpanMock, uploadStartMock } = vi.hoisted(
  () => ({
    apiPostMock: vi.fn(),
    spanEndMock: vi.fn(),
    spanFailMock: vi.fn(),
    startSpanMock: vi.fn(),
    uploadStartMock: vi.fn(),
  })
);

vi.mock('@/api/client', () => ({
  apiClient: { post: apiPostMock },
}));

vi.mock('@/lib/hyperdx', () => ({
  startHyperdxBrowserSpan: startSpanMock,
}));

vi.mock('tus-js-client', () => ({
  Upload: class {
    start = uploadStartMock;
  },
}));

import { uploadPackageFile } from '@/lib/upload';

describe('upload telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiPostMock.mockResolvedValue({
      versionId: 'version-sensitive',
      exp: '123',
      sig: 'secret',
      tusEndpoint: 'https://ingest.test/files',
      headers: {},
    });
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
  });
});
