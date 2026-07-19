import { initSDK, setTraceAttributes } from '@hyperdx/node-opentelemetry';
import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import {
  applyNodeHyperdxDefaults,
  classifyHttpOperationOutcome,
  detectServerObservabilityRuntime,
  setActiveSpanAttributes,
  toSpanAttributes,
  withObservedSpan,
} from '@yucp/shared';
import { initBunServerObservability } from '@yucp/shared/serverObservability';

const tracer = trace.getTracer('yucp-api');
let initialized = false;

export function sanitizeApiRequestUrl(value: string | URL): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/^(\/api\/vpm\/)[^/]+(\/index\.json)$/, '$1[REDACTED]$2');
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
  const carrier = Object.fromEntries(request.headers.entries());
  const parentContext = propagation.extract(ROOT_CONTEXT, carrier);

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
          requestId,
        }),
      },
      async (span) => {
        annotateApiSpan({
          'app.operation.type': 'api.request',
          requestId,
          route: url.pathname,
          method: request.method,
        });

        try {
          const result = await run();
          if (result instanceof Response) {
            span.setAttribute('http.response.status_code', result.status);
            span.setAttribute('app.operation.outcome', classifyHttpOperationOutcome(result.status));
            if (result.status >= 500) {
              span.setStatus({ code: SpanStatusCode.ERROR });
            }
          }
          return result;
        } catch (error) {
          if (error instanceof Error) {
            span.recordException(error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message,
            });
          }
          throw error;
        } finally {
          span.end();
        }
      }
    )
  );
}
