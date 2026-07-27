import { type LocalWorkerProxy, startLocalWorkerProxy } from '../../ops/testing/localWorkerProxy';

export type LocalDeliveryProxy = LocalWorkerProxy;

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
  renditionUpstreamFetch?: (request: Request) => Promise<Response>;
  renditionUpstreamBaseUrl?: string;
  upstreamFetch?: (request: Request) => Promise<Response>;
  upstreamBaseUrl: string;
}): Promise<LocalDeliveryProxy> {
  const upstreamBaseUrl = requireLoopbackBaseUrl(input.upstreamBaseUrl);
  const renditionUpstreamBaseUrl = input.renditionUpstreamBaseUrl
    ? requireLoopbackBaseUrl(input.renditionUpstreamBaseUrl)
    : undefined;
  return startLocalWorkerProxy({
    allowedMethods: ['GET', 'HEAD'],
    maxRequestBytes: 2 * 1024 * 1024,
    port: input.port,
    resolveRoute({ pathname }) {
      const isRendition = pathname.startsWith('/v2/renditions/');
      if (isRendition && renditionUpstreamBaseUrl) {
        return {
          allowedMethods: ['POST'],
          upstreamBaseUrl: renditionUpstreamBaseUrl.toString(),
          upstreamFetch: input.renditionUpstreamFetch,
        };
      }
      return {
        allowedMethods: ['GET', 'HEAD'],
        upstreamBaseUrl: upstreamBaseUrl.toString(),
        upstreamFetch: input.upstreamFetch,
      };
    },
    upstreamBaseUrl: upstreamBaseUrl.toString(),
    upstreamFetch: input.upstreamFetch,
  });
}
