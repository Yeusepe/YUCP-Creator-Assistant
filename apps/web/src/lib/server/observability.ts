import { context, propagation, ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import { getRequest, getRequestHeaders } from '@tanstack/react-start/server';
import { withObservedSpan } from '@yucp/shared';
import { initBunServerObservability } from '@yucp/shared/serverObservability';

const tracer = trace.getTracer('yucp-web-server');

type ObservableValue = string | number | boolean | undefined;

export function buildIncomingTraceCarrier(headers: Headers): Record<string, string> {
  const traceparent = headers.get('traceparent')?.trim();
  const tracestate = headers.get('tracestate')?.trim();
  const baggage = headers.get('baggage')?.trim();

  return Object.fromEntries(
    [
      ['traceparent', traceparent],
      ['tracestate', tracestate],
      ['baggage', baggage],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}

function initWebServerObservability(env: NodeJS.ProcessEnv = process.env) {
  const resolved = initBunServerObservability({
    env,
    serviceName: 'yucp-web-server',
    resourceAttributes: {
      'deployment.environment': env.NODE_ENV ?? 'development',
      'service.namespace': 'yucp',
      'service.version': env.BUILD_ID ?? 'dev',
    },
  });
  return resolved;
}

function getIncomingRequestCarrier(): Record<string, string> {
  try {
    return buildIncomingTraceCarrier(getRequest().headers);
  } catch {}

  try {
    return buildIncomingTraceCarrier(getRequestHeaders());
  } catch {}

  return {};
}

export async function withWebServerSpan<T>(
  name: string,
  attributes: Record<string, ObservableValue>,
  run: () => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL
): Promise<T> {
  initWebServerObservability(process.env);

  if (trace.getActiveSpan()) {
    return withObservedSpan(tracer, name, attributes, run, kind);
  }

  const parentContext = propagation.extract(ROOT_CONTEXT, getIncomingRequestCarrier());
  return context.with(parentContext, () => withObservedSpan(tracer, name, attributes, run, kind));
}

export async function withWebServerRequestSpan<T>(
  name: string,
  attributes: Record<string, ObservableValue>,
  run: () => Promise<T>
): Promise<T> {
  initWebServerObservability(process.env);
  const parentContext = propagation.extract(ROOT_CONTEXT, getIncomingRequestCarrier());
  return context.with(parentContext, () =>
    withObservedSpan(tracer, name, attributes, run, SpanKind.SERVER)
  );
}

export function getActiveWebServerTraceId(): string | undefined {
  return trace.getActiveSpan()?.spanContext().traceId;
}
