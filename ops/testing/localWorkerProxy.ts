import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export type LocalWorkerProxy = {
  baseUrl: string;
  port: number;
  stop: () => Promise<void>;
};

export type LocalWorkerProxyRoute = {
  allowedMethods: readonly string[];
  upstreamBaseUrl: string;
  upstreamFetch?: (request: Request) => Promise<Response>;
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
    throw new Error('The local Worker upstream must use loopback HTTP');
  }
  return url;
}

function copyEndToEndRequestHeaders(input: IncomingHttpHeaders): Headers {
  const excluded = new Set(HOP_BY_HOP_HEADERS);
  for (const value of String(input.connection ?? '').split(',')) {
    const name = value.trim().toLowerCase();
    if (name) {
      excluded.add(name);
    }
  }

  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(input)) {
    if (excluded.has(name.toLowerCase()) || rawValue === undefined) {
      continue;
    }
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) {
        headers.append(name, value);
      }
    } else {
      headers.set(name, rawValue);
    }
  }
  return headers;
}

export async function startLocalWorkerProxy(input: {
  allowedMethods: readonly string[];
  maxRequestBytes?: number;
  port: number;
  resolveRoute?: (request: { method: string; pathname: string }) => LocalWorkerProxyRoute;
  upstreamBaseUrl: string;
  upstreamFetch?: (request: Request) => Promise<Response>;
}): Promise<LocalWorkerProxy> {
  const defaultRoute: LocalWorkerProxyRoute = {
    allowedMethods: input.allowedMethods,
    upstreamBaseUrl: requireLoopbackBaseUrl(input.upstreamBaseUrl).toString(),
    upstreamFetch: input.upstreamFetch,
  };
  const maxRequestBytes = input.maxRequestBytes ?? 2 * 1024 * 1024;
  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const route =
      input.resolveRoute?.({
        method,
        pathname: requestUrl.pathname,
      }) ?? defaultRoute;
    if (!route.allowedMethods.includes(method)) {
      response.writeHead(405, {
        Allow: route.allowedMethods.join(', '),
      });
      response.end('Method not allowed');
      return;
    }

    const abortController = new AbortController();
    request.once('aborted', () => abortController.abort());
    try {
      const targetBaseUrl = route.upstreamFetch
        ? requireLoopbackBaseUrl(`http://${request.headers.host ?? ''}`)
        : requireLoopbackBaseUrl(route.upstreamBaseUrl);
      const target = new URL(request.url ?? '/', targetBaseUrl);
      const body =
        method === 'GET' || method === 'HEAD'
          ? undefined
          : await readBoundedRequestBody(request, maxRequestBytes);
      const bodyBuffer = body
        ? (body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer)
        : undefined;
      const upstreamRequest = new Request(target, {
        ...(bodyBuffer ? { body: bodyBuffer } : {}),
        headers: copyEndToEndRequestHeaders(request.headers),
        method,
        redirect: 'manual',
        signal: abortController.signal,
      });
      const upstream = route.upstreamFetch
        ? await route.upstreamFetch(upstreamRequest)
        : await fetch(upstreamRequest);
      response.statusCode = upstream.status;
      upstream.headers.forEach((value, name) => {
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
          response.setHeader(name, value);
        }
      });
      if (!upstream.body || method === 'HEAD') {
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
        response.end('Local Worker unavailable');
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
    throw new Error('The local Worker proxy did not bind a TCP port');
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

async function readBoundedRequestBody(
  request: AsyncIterable<Uint8Array>,
  limit: number
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.byteLength;
    if (received > limit) {
      throw new Error('Local Worker request body exceeded its limit');
    }
    chunks.push(chunk);
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
