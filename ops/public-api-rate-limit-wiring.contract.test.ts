import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readApiEntrypoint(): string {
  return readFileSync(resolve(process.cwd(), 'apps/api/src/index.ts'), 'utf8');
}

describe('public API rate-limit wiring', () => {
  test('rate limits upload authorization and VPM access before dispatch', () => {
    const source = readApiEntrypoint();
    const uploadLimiterIndex = source.indexOf(
      "if (pathname.startsWith('/api/creator/uploads/authorize'))"
    );
    const uploadDispatchIndex = source.indexOf(
      "if (pathname === '/api/creator/uploads/authorize' && creatorUploadRoutes)"
    );
    const vpmLimiterIndex = source.indexOf("if (pathname.startsWith('/api/vpm/'))");
    const vpmDispatchIndex = source.indexOf('const creatorVpmIndexMatch =');

    expect(uploadLimiterIndex).toBeGreaterThan(-1);
    expect(uploadDispatchIndex).toBeGreaterThan(uploadLimiterIndex);
    expect(source).toContain(
      'isRateLimited(`creator-upload-authorize:${clientAddress}`, 30, 60_000)'
    );
    expect(vpmLimiterIndex).toBeGreaterThan(-1);
    expect(vpmDispatchIndex).toBeGreaterThan(vpmLimiterIndex);
    expect(source).toContain('isRateLimited(`vpm:${clientAddress}`, 120, 60_000)');
    expect(source).not.toContain("pathname.startsWith('/api/access/')");
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
