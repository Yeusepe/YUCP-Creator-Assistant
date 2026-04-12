import { type Attributes, SpanKind, SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';

export type ObservableValue = string | number | boolean | undefined | null;
export type ObservableAttributes = Record<string, ObservableValue>;

export function toSpanAttributes(input: ObservableAttributes): Attributes {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null)
  ) as Attributes;
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
      attributes: toSpanAttributes(attributes),
    },
    async (span) => {
      try {
        return await run();
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
  );
}
