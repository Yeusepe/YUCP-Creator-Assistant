import { SpanStatusCode, trace } from '@opentelemetry/api';
import { parseTraceparent, redactString } from '@yucp/shared';
import { logger } from '../lib/logger';
import { annotateApiSpan } from '../lib/observability';

const MAX_BODY_BYTES = 12_000;
const MAX_TEXT_LENGTH = 2_000;
const DIAGNOSTICS_SESSION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type NativeTelemetryPayload = {
  event?: unknown;
  severity?: unknown;
  service?: unknown;
  process?: unknown;
  operation?: unknown;
  phase?: unknown;
  errorCode?: unknown;
  status?: unknown;
  durationMs?: unknown;
  runId?: unknown;
  releaseId?: unknown;
  os?: unknown;
  arch?: unknown;
  message?: unknown;
};

function readSafeText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  return value.trim().slice(0, MAX_TEXT_LENGTH);
}

function readSafeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function diagnosticsSessionId(request: Request): string | undefined {
  const value = request.headers.get('x-yucp-diagnostics-session')?.trim();
  return value && DIAGNOSTICS_SESSION_PATTERN.test(value) ? value : undefined;
}

export async function handleNativeTelemetry(
  request: Request,
  resolveConsent: (diagnosticsSessionId: string) => Promise<boolean>
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'POST' },
    });
  }

  const sessionId = diagnosticsSessionId(request);
  const traceparent = request.headers.get('traceparent')?.trim() ?? '';
  if (!sessionId || !parseTraceparent(traceparent)) {
    return new Response('Diagnostics consent and trace context are required', { status: 401 });
  }
  try {
    if (!(await resolveConsent(sessionId))) {
      return new Response('Diagnostics consent is not active', { status: 403 });
    }
  } catch {
    return new Response('Diagnostics consent is unavailable', { status: 503 });
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

  const payload = parsed as NativeTelemetryPayload;
  const event = readSafeText(payload.event) ?? 'native.operation';
  const severity = readSafeText(payload.severity) ?? 'info';
  const service = readSafeText(payload.service) ?? 'yucp-native';
  const process = readSafeText(payload.process) ?? 'unknown';
  const operation = readSafeText(payload.operation);
  const phase = readSafeText(payload.phase);
  const errorCode = readSafeText(payload.errorCode);
  const status = readSafeInteger(payload.status);
  const durationMs = readSafeInteger(payload.durationMs);
  const runId = readSafeText(payload.runId);
  const releaseId = readSafeText(payload.releaseId);
  const os = readSafeText(payload.os);
  const arch = readSafeText(payload.arch);
  const message = readSafeText(payload.message);
  const metadata = {
    event,
    native: true,
    severity,
    service,
    process,
    operation,
    phase,
    errorCode,
    status,
    durationMs,
    runId,
    releaseId,
    os,
    arch,
    message: message ? redactString(message) : undefined,
    'diagnostics.session.id': sessionId,
    'trace.id': parseTraceparent(traceparent)?.traceId,
    consent: 'helpful-diagnostics',
  };

  annotateApiSpan({
    'app.operation.name': 'native.telemetry.event',
    'telemetry.source': 'native',
    'native.event': event,
    'native.service.name': service,
    'native.process': process,
    'native.operation': operation,
    'native.phase': phase,
    'native.error.code': errorCode,
    'native.http.status_code': status,
    'native.run.id': runId,
    'release.id': releaseId,
    'diagnostics.session.id': sessionId,
  });

  if (severity === 'error' || (status !== undefined && status >= 500)) {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorCode ?? event,
      });
      if (message) {
        activeSpan.recordException(new Error(redactString(message)));
      }
    }
  }

  if (severity === 'error') {
    logger.error('Native operational telemetry', metadata);
  } else if (severity === 'warn') {
    logger.warn('Native operational telemetry', metadata);
  } else {
    logger.info('Native operational telemetry', metadata);
  }

  return new Response(null, { status: 204 });
}
