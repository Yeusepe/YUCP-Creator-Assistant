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
            if (result.status >= 500) {
              recordActiveException(
                Object.assign(
                  new Error(`HTTP ${result.status} ${request.method} ${url.pathname}`),
                  { name: 'HttpServerError' }
                ),
                {
                  'event.name': 'http.server.error',
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
