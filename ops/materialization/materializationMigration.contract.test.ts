import { describe, expect, it } from 'bun:test';

describe('Cloudflare materialization database migration', () => {
  it('persists atomic Cloudflare dispatch without a rendition object-storage upload table', async () => {
    const migration = await Bun.file(
      new URL('../catalog/migrations/0029_cloudflare_materialization_dispatch.sql', import.meta.url)
    ).text();

    expect(migration).toContain('materialization_dispatch_outbox');
    expect(migration).toContain('FOR UPDATE SKIP LOCKED');
    expect(migration).not.toContain('materialization_rendition_multipart');
    expect(migration).not.toMatch(/presigned|signed_url|upload_id|part_receipts/i);
  });
});
