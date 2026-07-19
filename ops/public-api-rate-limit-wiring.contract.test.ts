import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readApiEntrypoint(): string {
  return readFileSync(resolve(process.cwd(), 'apps/api/src/index.ts'), 'utf8');
}

describe('public API rate-limit wiring', () => {
  test('rate limits upload authorization and buyer downloads before dispatch', () => {
    const source = readApiEntrypoint();
    const uploadLimiterIndex = source.indexOf(
      "if (pathname.startsWith('/api/creator/uploads/authorize'))"
    );
    const uploadDispatchIndex = source.indexOf(
      "if (pathname === '/api/creator/uploads/authorize' && creatorUploadRoutes)"
    );
    const downloadLimiterIndex = source.indexOf("if (pathname.startsWith('/api/access/'))");
    const downloadDispatchIndex = source.indexOf(
      'const buyerDownloadMatch = pathname.match(/^\\/api\\/access\\/([^/]+)\\/download$/);'
    );

    expect(uploadLimiterIndex).toBeGreaterThan(-1);
    expect(uploadDispatchIndex).toBeGreaterThan(uploadLimiterIndex);
    expect(source).toContain("isRateLimited(`creator-upload-authorize:${clientAddress}`, 30, 60_000)");
    expect(downloadLimiterIndex).toBeGreaterThan(-1);
    expect(downloadDispatchIndex).toBeGreaterThan(downloadLimiterIndex);
    expect(source).toContain("isRateLimited(`buyer-download:${clientAddress}`, 120, 60_000)");
  });

  test('checks public API requests before dispatching v1 or v2 handlers', () => {
    const source = readApiEntrypoint();
    const limiterIndex = source.indexOf("if (pathname.startsWith('/api/public/'))");
    const publicV2DispatchIndex = source.indexOf(
      "if (pathname.startsWith('/api/public/v2/') && publicV2Routes)"
    );
    const publicV1DispatchIndex = source.indexOf(
      "if (pathname.startsWith('/api/public/') && publicRoutes)"
    );

    expect(limiterIndex).toBeGreaterThan(-1);
    expect(publicV2DispatchIndex).toBeGreaterThan(limiterIndex);
    expect(publicV1DispatchIndex).toBeGreaterThan(limiterIndex);
    expect(source).toContain('checkPublicApiRateLimit({');
    expect(source).toContain('getPublicApiRateLimitStore()');
    expect(source).toContain('publicApiRateLimitHeaders = rateLimit.headers;');
    expect(source).toContain('if (!rateLimit.allowed)');
  });

  test('propagates limiter headers on accepted public API responses', () => {
    const source = readApiEntrypoint();

    expect(source).toContain('withExtraHeaders(response, publicApiRateLimitHeaders)');
  });
});
