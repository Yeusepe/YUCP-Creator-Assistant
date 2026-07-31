import { redactForLogging, redactString } from '@yucp/shared';
import { logger } from '../lib/logger';
import { annotateApiSpan } from '../lib/observability';

const MAX_BODY_BYTES = 12_000;
const MAX_TEXT_LENGTH = 2_000;

function readSafeText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  return redactString(value).slice(0, MAX_TEXT_LENGTH);
}

function safeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return redactForLogging(value as Record<string, unknown>);
}

export async function handleBrowserTelemetry(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'POST' },
    });
  }

  const contentLength = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return Response.json({ error: 'Telemetry payload too large' }, { status: 413 });
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return Response.json({ error: 'Telemetry payload too large' }, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return Response.json({ error: 'Invalid telemetry payload' }, { status: 400 });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Response.json({ error: 'Invalid telemetry payload' }, { status: 400 });
  }

  const payload = parsed as Record<string, unknown>;
  const event = readSafeText(payload.event) ?? 'unknown-browser-error';
  const error = safeRecord(payload.error);
  const context = safeRecord(payload.context);
  const route = readSafeText(payload.route);
  const release = readSafeText(payload.release);

  annotateApiSpan({
    'app.operation.name': 'browser.telemetry.error',
    'browser.error.event': event,
    'browser.error.route': route,
    'release.id': release,
  });

  logger.error('Browser operational telemetry', {
    event,
    error,
    context,
    route,
    release,
    userAgent: readSafeText(payload.userAgent),
    consent: 'necessary-only',
  });

  return new Response(null, { status: 204 });
}
