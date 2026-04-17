import { describe, expect, it } from 'vitest';
import { resolveDefaultWebRuntimeEnv, type WebRuntimeEnv } from '@/lib/server/runtimeEnv';

describe('resolveDefaultWebRuntimeEnv', () => {
  it('prefers Cloudflare Worker bindings over process env in Worker runtime', () => {
    const fallbackEnv = {
      CONVEX_SITE_URL: 'https://dev-example.convex.site',
      CONVEX_URL: 'https://dev-example.convex.cloud',
    } satisfies WebRuntimeEnv;
    const runtimeCloudflareEnv = {
      CONVEX_SITE_URL: 'https://prod-example.convex.site',
      CONVEX_URL: 'https://prod-example.convex.cloud',
    } satisfies WebRuntimeEnv;

    expect(
      resolveDefaultWebRuntimeEnv({
        fallbackEnv,
        runtimeCloudflareEnv,
        workerRuntime: true,
      })
    ).toEqual(runtimeCloudflareEnv);
  });

  it('falls back to process env outside Worker runtime', () => {
    const fallbackEnv = {
      CONVEX_SITE_URL: 'https://dev-example.convex.site',
      CONVEX_URL: 'https://dev-example.convex.cloud',
    } satisfies WebRuntimeEnv;
    const runtimeCloudflareEnv = {
      CONVEX_SITE_URL: 'https://prod-example.convex.site',
      CONVEX_URL: 'https://prod-example.convex.cloud',
    } satisfies WebRuntimeEnv;

    expect(
      resolveDefaultWebRuntimeEnv({
        fallbackEnv,
        runtimeCloudflareEnv,
        workerRuntime: false,
      })
    ).toEqual(fallbackEnv);
  });
});
