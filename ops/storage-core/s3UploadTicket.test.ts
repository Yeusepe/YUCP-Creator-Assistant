import { describe, expect, test } from 'bun:test';
import { createS3PutObjectUploadTicket } from './s3Control';

describe('S3 rendition upload tickets', () => {
  test('binds the exact object, length, digest, type, and short expiry', async () => {
    const ticket = await createS3PutObjectUploadTicket({
      bytes: 4096,
      config: {
        accessKeyId: 'test-access-key',
        bucket: 'renditions-test',
        chunkPrefix: 'chunks/',
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        indexPrefix: 'indexes/',
        region: 'us-west-004',
        requestTimeoutMs: 30_000,
        secretAccessKey: 'test-secret-key',
      },
      contentType: 'application/zip',
      expiresSeconds: 300,
      key: 'v2/renditions/job-1/capability-1.zip',
      now: new Date('2026-07-24T12:00:00.000Z'),
      sha256Hex: 'ab'.repeat(32),
    });

    const url = new URL(ticket.url);
    expect(url.origin).toBe('https://s3.us-west-004.backblazeb2.com');
    expect(url.pathname).toBe('/renditions-test/v2/renditions/job-1/capability-1.zip');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;x-amz-content-sha256;x-amz-meta-yucp-sha256'
    );
    expect(ticket.headers).toEqual({
      'content-length': '4096',
      'content-type': 'application/zip',
      'x-amz-content-sha256': 'ab'.repeat(32),
      'x-amz-meta-yucp-sha256': 'ab'.repeat(32),
    });
    expect(ticket.url).not.toContain('test-secret-key');
  });

  test('rejects unbounded tickets and invalid rendition digests', async () => {
    const config = {
      accessKeyId: 'test-access-key',
      bucket: 'renditions-test',
      chunkPrefix: 'chunks/',
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      indexPrefix: 'indexes/',
      region: 'us-west-004',
      requestTimeoutMs: 30_000,
      secretAccessKey: 'test-secret-key',
    };

    await expect(
      createS3PutObjectUploadTicket({
        bytes: 1,
        config,
        contentType: 'application/zip',
        expiresSeconds: 901,
        key: 'v2/renditions/job-1/capability-1.zip',
        sha256Hex: 'ab'.repeat(32),
      })
    ).rejects.toThrow('expiry');

    await expect(
      createS3PutObjectUploadTicket({
        bytes: 1,
        config,
        contentType: 'application/zip',
        expiresSeconds: 300,
        key: 'v2/renditions/job-1/capability-1.zip',
        sha256Hex: 'not-a-digest',
      })
    ).rejects.toThrow('digest');
  });
});
