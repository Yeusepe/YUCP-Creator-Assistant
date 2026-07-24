import { afterEach, describe, expect, test } from 'bun:test';
import { type LocalDeliveryProxy, startLocalDeliveryProxy } from './localDevProxy';

let upstream: ReturnType<typeof Bun.serve> | undefined;
let proxy: LocalDeliveryProxy | undefined;

afterEach(async () => {
  await proxy?.stop();
  proxy = undefined;
  upstream?.stop(true);
  upstream = undefined;
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
});
