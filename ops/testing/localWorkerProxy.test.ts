import { afterEach, describe, expect, test } from 'bun:test';
import { type LocalWorkerProxy, startLocalWorkerProxy } from './localWorkerProxy';

let proxy: LocalWorkerProxy | undefined;

afterEach(async () => {
  await proxy?.stop();
  proxy = undefined;
});

describe('local Worker proxy', () => {
  test('serves an in-process Worker client through a stable loopback listener', async () => {
    let receivedRequest: Request | undefined;
    proxy = await startLocalWorkerProxy({
      allowedMethods: ['GET'],
      port: 0,
      upstreamBaseUrl: 'http://127.0.0.1:1',
      upstreamFetch: async (request) => {
        receivedRequest = request;
        return new Response('ready', {
          headers: { 'X-Worker-Result': 'served' },
        });
      },
    });

    const response = await fetch(`${proxy.baseUrl}/v2/source/version-1/manifest`, {
      headers: {
        Connection: 'keep-alive',
        'X-Trace-Id': 'trace-1',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ready');
    expect(response.headers.get('x-worker-result')).toBe('served');
    expect(receivedRequest).toBeDefined();
    expect(receivedRequest?.url).toBe(`${proxy.baseUrl}/v2/source/version-1/manifest`);
    expect(new URL(receivedRequest?.url ?? '').pathname).toBe('/v2/source/version-1/manifest');
    expect(receivedRequest?.headers.get('x-trace-id')).toBe('trace-1');
    expect(receivedRequest?.headers.get('host')).toBeNull();
    expect(receivedRequest?.headers.get('connection')).toBeNull();
  });
});
