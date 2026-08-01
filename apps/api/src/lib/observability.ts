import { initSDK, setTraceAttributes } from '@hyperdx/node-opentelemetry';
import { context, propagation, ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import {
  applyNodeHyperdxDefaults,
  classifyHttpOperationOutcome,
  detectServerObservabilityRuntime,
  recordActiveException,
  setActiveSpanAttributes,
  toSpanAttributes,
  withObservedSpan,
} from '@yucp/shared';
import { initBunServerObservability } from '@yucp/shared/serverObservability';

const tracer = trace.getTracer('yucp-api');
let initialized = false;
const DIAGNOSTICS_SESSION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DiagnosticsConsentResolver = (diagnosticsSessionId: string) => Promise<boolean>;

let diagnosticsConsentResolver: DiagnosticsConsentResolver = async () => false;

function getDiagnosticsSessionId(request: Request): string | undefined {
  const value = request.headers.get('x-yucp-diagnostics-session')?.trim();
  return value && DIAGNOSTICS_SESSION_PATTERN.test(value) ? value : undefined;
}

export function setApiDiagnosticsConsentResolver(resolver: DiagnosticsConsentResolver): void {
  diagnosticsConsentResolver = resolver;
}

export async function resolveDiagnosticsSessionId(
  request: Request,
  resolver: DiagnosticsConsentResolver = diagnosticsConsentResolver
): Promise<string | undefined> {
  const sessionId = getDiagnosticsSessionId(request);
  if (!sessionId) {
    return undefined;
  }

  try {
    return (await resolver(sessionId)) ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeApiRequestUrl(value: string | URL): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(
    /^(\/api\/vpm\/access\/)[^/]+(\/index\.json)$/,
    '$1[REDACTED]$2'
  );
  url.search = '';
  url.hash = '';
  return url;
}

// Routes emit SCREAMING_SNAKE codes; provider-facing routes emit lowercase
// snake ones (invalid_proof, provider_link_expired). Both are ours, and
// rejecting the second silently stripped error.code from every 422.
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{2,63}$/;
// An error body is small JSON. A response that claims otherwise, or that never
// terminates, must not be allowed to buffer into the tracing path.
const MAXIMUM_ERROR_BODY_BYTES = 16 * 1024;
const ERROR_BODY_READ_TIMEOUT_MS = 250;

// Error responses carry a stable `errorCode` in their body, but the span only ever recorded the
// status. That made every 4xx indistinguishable in tracing: an expired authorization and a stale
// content approval are both "403". Lift the code onto the span so failures are queryable by cause.
// The clone is read through a bounded, deadlined reader: an oversized or
// non-terminating body would otherwise hold the request open and grow the tee
// buffer without limit, turning observability into a denial of service.
export async function readResponseErrorCode(response: Response): Promise<string | undefined> {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    return undefined;
  }
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > MAXIMUM_ERROR_BODY_BYTES) {
    return undefined;
  }
  const clone = response.clone();
  const reader = clone.body?.getReader();
  if (!reader) {
    return undefined;
  }
  const deadline = setTimeout(() => {
    void reader.cancel().catch(() => undefined);
  }, ERROR_BODY_READ_TIMEOUT_MS);
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > MAXIMUM_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const code = (body as { errorCode?: unknown } | null)?.errorCode;
    return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
}

export function initApiObservability(env: NodeJS.ProcessEnv = process.env) {
  if (detectServerObservabilityRuntime() === 'bun-manual') {
    const resolved = initBunServerObservability({
      env,
      serviceName: 'yucp-api',
      resourceAttributes: {
        'deployment.environment': env.NODE_ENV ?? 'development',
        'service.namespace': 'yucp',
        'service.version': env.BUILD_ID ?? 'dev',
      },
    });
    initialized ||= resolved.hasOtelAuth;
    return resolved;
  }

  const resolved = applyNodeHyperdxDefaults(env, 'yucp-api');
  if (initialized || !resolved.hasOtelAuth) {
    return resolved;
  }

  initSDK({
    consoleCapture: true,
    additionalResourceAttributes: {
      'deployment.environment': env.NODE_ENV ?? 'development',
      'service.namespace': 'yucp',
      'service.version': env.BUILD_ID ?? 'dev',
    },
  });

  initialized = true;
  return resolved;
}

export function getActiveTraceIds() {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return {
    traceId: spanContext?.traceId,
    spanId: spanContext?.spanId,
  };
}

export function annotateApiSpan(attributes: Record<string, string | number | boolean | undefined>) {
  setActiveSpanAttributes(attributes);
  setTraceAttributes(
    Object.fromEntries(
      Object.entries(attributes)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)])
    )
  );
}

export async function withApiSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  run: () => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL
): Promise<T> {
  return withObservedSpan(
    tracer,
    name,
    {
      'app.operation.type': 'api.operation',
      ...attributes,
    },
    async () => {
      annotateApiSpan({
        'app.operation.type': 'api.operation',
        ...attributes,
      });
      return run();
    },
    kind
  );
}

export async function withApiRequestSpan<T>(
  request: Request,
  requestId: string,
  run: () => Promise<T>
): Promise<T> {
  const url = sanitizeApiRequestUrl(request.url);
  const carrier = Object.fromEntries(
    [
      ['traceparent', request.headers.get('traceparent')?.trim()],
      ['tracestate', request.headers.get('tracestate')?.trim()],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
  const parentContext = propagation.extract(ROOT_CONTEXT, carrier);
  const diagnosticsSessionId = await resolveDiagnosticsSessionId(request);

  return context.with(parentContext, async () =>
    tracer.startActiveSpan(
      `${request.method} ${url.pathname}`,
      {
        kind: SpanKind.SERVER,
        attributes: toSpanAttributes({
          'http.request.method': request.method,
          'url.full': url.toString(),
          'url.path': url.pathname,
          'http.route': url.pathname,
          'app.operation.type': 'api.request',
          'user_agent.original': request.headers.get('user-agent') ?? undefined,
          'diagnostics.session.id': diagnosticsSessionId,
          'request.id': requestId,
          requestId,
        }),
      },
      async (span) => {
        annotateApiSpan({
          'app.operation.type': 'api.request',
          'request.id': requestId,
          requestId,
          route: url.pathname,
          method: request.method,
          'diagnostics.session.id': diagnosticsSessionId,
        });

        try {
          const result = await run();
          if (result instanceof Response) {
            span.setAttribute('http.response.status_code', result.status);
            span.setAttribute('app.operation.outcome', classifyHttpOperationOutcome(result.status));
            const errorCode =
              result.status >= 400 ? await readResponseErrorCode(result) : undefined;
            if (errorCode) {
              // Deliberately not a span error status: a 4xx is the caller's fault, and flipping
              // status would drown real faults in routine 401s. The attribute keeps it queryable.
              annotateApiSpan({ 'error.code': errorCode });
            }
            if (result.status >= 500) {
              recordActiveException(
                Object.assign(
                  new Error(`HTTP ${result.status} ${request.method} ${url.pathname}`),
                  { name: 'HttpServerError' }
                ),
                {
                  'event.name': 'http.server.error',
                  ...(errorCode ? { 'error.code': errorCode } : {}),
                  'http.response.status_code': result.status,
                  'http.route': url.pathname,
                }
              );
            }
          }
          return result;
        } catch (error) {
          if (error instanceof Error) {
            recordActiveException(error);
          }
          throw error;
        } finally {
          span.end();
        }
      }
    )
  );
}
