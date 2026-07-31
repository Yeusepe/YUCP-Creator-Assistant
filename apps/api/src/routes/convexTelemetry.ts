import { redactForLogging, redactString } from '@yucp/shared';
import { logger } from '../lib/logger';
import { annotateApiSpan } from '../lib/observability';

const MAX_BODY_BYTES = 1_000_000;

function getConfiguredSecret() {
  return process.env.CONVEX_LOG_STREAM_SECRET?.trim() ?? '';
}

function isAuthorized(request: Request) {
  const configuredSecret = getConfiguredSecret();
  if (!configuredSecret) {
    return false;
  }

  const suppliedSecret =
    request.headers.get('x-convex-log-stream-secret')?.trim() ??
    request.headers
      .get('authorization')
      ?.replace(/^Bearer\s+/i, '')
      .trim() ??
    '';
  return suppliedSecret.length > 0 && suppliedSecret === configuredSecret;
}

export async function handleConvexTelemetry(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'POST' },
    });
  }

  if (!isAuthorized(request)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const contentLength = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return Response.json({ error: 'Telemetry payload too large' }, { status: 413 });
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return Response.json({ error: 'Telemetry payload too large' }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: 'Invalid telemetry payload' }, { status: 400 });
  }

  const safePayload = redactForLogging(payload);
  const serialized = redactString(JSON.stringify(safePayload));
  annotateApiSpan({
    'app.operation.name': 'convex.telemetry.log-stream',
    'telemetry.source': 'convex',
    'telemetry.payload.bytes': body.length,
  });
  logger.info('Convex log stream event', {
    source: 'convex',
    payload: serialized.slice(0, MAX_BODY_BYTES),
  });

  return new Response(null, { status: 204 });
}
