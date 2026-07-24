import { once } from 'node:events';
import { createServer } from 'node:http';

export type LocalDeliveryProxy = {
  baseUrl: string;
  port: number;
  stop: () => Promise<void>;
};

function requireLoopbackBaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('The local delivery upstream must use loopback HTTP');
  }
  return url;
}

export async function startLocalDeliveryProxy(input: {
  port: number;
  upstreamBaseUrl: string;
}): Promise<LocalDeliveryProxy> {
  const upstreamBaseUrl = requireLoopbackBaseUrl(input.upstreamBaseUrl);
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('Method not allowed');
      return;
    }

    const abortController = new AbortController();
    request.once('aborted', () => abortController.abort());
    try {
      const target = new URL(request.url ?? '/', upstreamBaseUrl);
      const upstream = await fetch(target, {
        headers: request.headers as HeadersInit,
        method: request.method,
        redirect: 'manual',
        signal: abortController.signal,
      });
      response.statusCode = upstream.status;
      upstream.headers.forEach((value, name) => {
        response.setHeader(name, value);
      });
      if (!upstream.body || request.method === 'HEAD') {
        response.end();
        return;
      }
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (!response.write(Buffer.from(value))) {
            await once(response, 'drain');
          }
        }
      } finally {
        reader.releaseLock();
      }
      response.end();
    } catch {
      if (!response.headersSent) {
        response.writeHead(502, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end('Local delivery Worker unavailable');
      } else {
        response.destroy();
      }
    }
  });

  server.listen(input.port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('The local delivery proxy did not bind a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    async stop() {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}
