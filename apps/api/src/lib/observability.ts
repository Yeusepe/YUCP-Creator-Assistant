import { initSDK, setTraceAttributes } from '@hyperdx/node-opentelemetry';
import {
  type Attributes,
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { applyNodeHyperdxDefaults } from '@yucp/shared';

const tracer = trace.getTracer('yucp-api');
let initialized = false;

function toAttributes(input: Record<string, string | number | boolean | undefined>): Attributes {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as Attributes;
}

function addSpanAttributes(attributes: Record<string, string | number | boolean | undefined>) {
  const span = trace.getActiveSpan();
  if (!span) {
    return;
  }

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      span.setAttribute(key, value);
    }
  }
}

export function initApiObservability(env: NodeJS.ProcessEnv = process.env) {
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
  addSpanAttributes(attributes);
  setTraceAttributes(
    Object.fromEntries(
      Object.entries(attributes)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)])
    )
  );
}

export async function withApiRequestSpan<T>(
  request: Request,
  requestId: string,
  run: () => Promise<T>
): Promise<T> {
  const url = new URL(request.url);
  const carrier = Object.fromEntries(request.headers.entries());
  const parentContext = propagation.extract(ROOT_CONTEXT, carrier);

  return context.with(parentContext, async () =>
    tracer.startActiveSpan(
      `${request.method} ${url.pathname}`,
      {
        kind: SpanKind.SERVER,
        attributes: toAttributes({
          'http.request.method': request.method,
          'url.full': url.toString(),
          'url.path': url.pathname,
          'http.route': url.pathname,
          'user_agent.original': request.headers.get('user-agent') ?? undefined,
          requestId,
        }),
      },
      async (span) => {
        annotateApiSpan({
          requestId,
          route: url.pathname,
          method: request.method,
        });

        try {
          const result = await run();
          if (result instanceof Response) {
            span.setAttribute('http.response.status_code', result.status);
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
