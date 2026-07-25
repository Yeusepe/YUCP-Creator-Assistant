import { afterEach, describe, expect, test } from 'bun:test';
import { type LocalDeliveryProxy, startLocalDeliveryProxy } from './localDevProxy';

let upstream: ReturnType<typeof Bun.serve> | undefined;
let renditionUpstream: ReturnType<typeof Bun.serve> | undefined;
let proxy: LocalDeliveryProxy | undefined;

afterEach(async () => {
  await proxy?.stop();
  proxy = undefined;
  upstream?.stop(true);
  upstream = undefined;
  renditionUpstream?.stop(true);
  renditionUpstream = undefined;
});

describe('local delivery proxy', () => {
  test('streams the Worker response through the configured stable listener', async () => {
    const bytes = new Uint8Array(512 * 1024).fill(0x5a);
    upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        expect(url.pathname).toBe('/d/version-ready');
        expect(url.searchParams.get('sig')).toBe('signed');
        return new Response(bytes, {
          status: 206,
          headers: {
            'Content-Length': String(bytes.byteLength),
            'Content-Range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
            'Content-Type': 'application/zip',
          },
        });
      },
    });
    proxy = await startLocalDeliveryProxy({
      port: 0,
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    });

    const response = await fetch(`${proxy.baseUrl}/d/version-ready?sig=signed`);

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(
      `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test('routes protected rendition posts through the stable delivery origin', async () => {
    upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response('wrong upstream', { status: 500 });
      },
    });
    renditionUpstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        expect(request.method).toBe('POST');
        expect(new URL(request.url).pathname).toBe('/v2/renditions/job-1');
        expect(await request.json()).toEqual({ receipt: 'signed-receipt' });
        return new Response('protected bytes', {
          headers: { 'Content-Type': 'application/zip' },
        });
      },
    });
    proxy = await startLocalDeliveryProxy({
      port: 0,
      renditionUpstreamBaseUrl: `http://127.0.0.1:${renditionUpstream.port}`,
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    });

    const response = await fetch(`${proxy.baseUrl}/v2/renditions/job-1`, {
      body: JSON.stringify({ receipt: 'signed-receipt' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('protected bytes');
  });

  test('uses the in-process Worker client without a second loopback fetch', async () => {
    let receivedPath = '';
    proxy = await startLocalDeliveryProxy({
      port: 0,
      upstreamBaseUrl: 'http://127.0.0.1:1',
      upstreamFetch: async (request) => {
        receivedPath = new URL(request.url).pathname;
        return new Response('worker response', { status: 200 });
      },
    });

    const response = await fetch(`${proxy.baseUrl}/v2/delivery/version-1/manifest`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('worker response');
    expect(receivedPath).toBe('/v2/delivery/version-1/manifest');
  });
});
