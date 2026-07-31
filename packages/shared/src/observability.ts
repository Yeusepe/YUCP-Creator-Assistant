import {
  type Attributes,
  metrics,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from '@opentelemetry/api';

const recordedExceptions = new WeakMap<object, Set<string>>();

export type ObservableValue = string | number | boolean | undefined | null;
export type ObservableAttributes = Record<string, ObservableValue>;
export type OperationOutcome = 'success' | 'redirect' | 'client_error' | 'server_error' | 'error';

const operationMeter = metrics.getMeter('yucp.shared.observability');
const operationCount = operationMeter.createCounter('yucp.operation.count', {
  description: 'Count of observed application operations',
});
const operationDuration = operationMeter.createHistogram('yucp.operation.duration', {
  description: 'Duration of observed application operations in milliseconds',
  unit: 'ms',
});

export function toSpanAttributes(input: ObservableAttributes): Attributes {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null)
  ) as Attributes;
}

function spanKindToOperationKind(kind: SpanKind): string {
  switch (kind) {
    case SpanKind.CLIENT:
      return 'client';
    case SpanKind.SERVER:
      return 'server';
    case SpanKind.PRODUCER:
      return 'producer';
    case SpanKind.CONSUMER:
      return 'consumer';
    default:
      return 'internal';
  }
}

export function classifyHttpOperationOutcome(statusCode: number): OperationOutcome {
  if (statusCode >= 500) {
    return 'server_error';
  }
  if (statusCode >= 400) {
    return 'client_error';
  }
  if (statusCode >= 300) {
    return 'redirect';
  }
  return 'success';
}

export function setActiveSpanAttributes(attributes: ObservableAttributes): void {
  const span = trace.getActiveSpan();
  if (!span) {
    return;
  }

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) {
      span.setAttribute(key, value);
    }
  }
}

function recordExceptionOnSpan(
  span: Span,
  error: Error,
  attributes: ObservableAttributes = {}
): boolean {
  const key = `${error.name}:${error.message}`;
  let spanExceptions = recordedExceptions.get(span);
  if (!spanExceptions) {
    spanExceptions = new Set<string>();
    recordedExceptions.set(span, spanExceptions);
  }

  if (!spanExceptions.has(key)) {
    span.recordException(error);
    spanExceptions.add(key);
  }

  const spanAttributes = {
    'app.operation.outcome': 'error',
    'error.type': error.name,
    'error.message': error.message,
    ...attributes,
  };
  for (const [key, value] of Object.entries(spanAttributes)) {
    if (value !== undefined && value !== null) {
      span.setAttribute(key, value);
    }
  }
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  return true;
}

export function recordActiveException(
  error: Error,
  attributes: ObservableAttributes = {}
): boolean {
  const span = trace.getActiveSpan();
  return span ? recordExceptionOnSpan(span, error, attributes) : false;
}

export async function withObservedSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: ObservableAttributes,
  run: () => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL
): Promise<T> {
  return tracer.startActiveSpan(
    name,
    {
      kind,
      attributes: toSpanAttributes({
        'app.operation.name': name,
        'app.operation.kind': spanKindToOperationKind(kind),
        ...attributes,
      }),
    },
    async (span) => {
      const startedAt = performance.now();
      let outcome: OperationOutcome = 'success';
      try {
        const result = await run();
        span.setAttribute('app.operation.outcome', 'success');
        return result;
      } catch (error) {
        outcome = 'error';
        span.setAttribute('app.operation.outcome', 'error');
        if (error instanceof Error) {
          recordExceptionOnSpan(span, error);
        }
        throw error;
      } finally {
        const metricAttributes = {
          'app.operation.kind': spanKindToOperationKind(kind),
          'app.operation.outcome': outcome,
        };
        operationCount.add(1, metricAttributes);
        operationDuration.record(performance.now() - startedAt, metricAttributes);
        span.end();
      }
    }
  );
}
