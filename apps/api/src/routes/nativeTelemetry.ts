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
  // Trace context is the correlation key for both tiers and is always available,
  // even for failures that happen before an install session is ever issued.
  if (!parseTraceparent(traceparent)) {
    return new Response('Trace context is required', { status: 401 });
  }
  // Two tiers. The operational tier is anonymous and code-only, so it needs no
  // consent: authentication failures happen before a session exists, and a
  // consent-gated-only channel could never report them. Consent adds the
  // diagnostics session correlation and the redacted message.
  const consented = sessionId !== undefined;
  if (consented) {
    try {
      if (!(await resolveConsent(sessionId))) {
        return new Response('Diagnostics consent is not active', { status: 403 });
      }
    } catch {
      return new Response('Diagnostics consent is unavailable', { status: 503 });
    }
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
  // Both tiers carry the reason. redactString runs server-side regardless of
  // what the client sent, so the anonymous tier cannot smuggle identifying text.
  const message = readSafeText(payload.message);
  const traceId = parseTraceparent(traceparent)?.traceId;
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
    'telemetry.tier': consented ? 'diagnostics' : 'operational',
    'diagnostics.session.id': sessionId,
    'trace.id': traceId,
    ...(consented ? { consent: 'helpful-diagnostics' } : {}),
  };

  annotateApiSpan({
    'app.operation.name': 'native.telemetry.event',
    'telemetry.source': 'native',
    'telemetry.tier': consented ? 'diagnostics' : 'operational',
    'native.event': event,
    'native.service.name': service,
    'native.process': process,
    'native.operation': operation,
    'native.phase': phase,
    'native.error.code': errorCode,
    'native.http.status_code': status,
    'native.duration_ms': durationMs,
    'native.run.id': runId,
    'release.id': releaseId,
    'os.type': os,
    'host.arch': arch,
    'diagnostics.session.id': sessionId,
    // OpenTelemetry's conventional low-cardinality grouping key: this is what
    // HyperDX facets and ClickHouse aggregates failures by.
    ...(errorCode ? { 'error.type': errorCode } : {}),
  });

  if (severity === 'error' || (status !== undefined && status >= 500)) {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorCode ?? event,
      });
      // A recorded exception gives HyperDX and ClickHouse the exception.type and
      // exception.message their error views read.
      const exception = new Error(message ? redactString(message) : (errorCode ?? event));
      exception.name = errorCode ?? 'NativeOperationFailed';
      activeSpan.recordException(exception);
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
