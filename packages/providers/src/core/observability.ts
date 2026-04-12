import { SpanKind, trace } from '@opentelemetry/api';
import { withObservedSpan } from '@yucp/shared';

const tracer = trace.getTracer('yucp-providers');

function sanitizePath(path: string): string {
  return path.replace(/\d+/g, ':id');
}

export function withProviderRequestSpan<T>(
  provider: string,
  method: string,
  path: string,
  attributes: Record<string, string | number | boolean | undefined>,
  run: () => Promise<T>
): Promise<T> {
  return withObservedSpan(
    tracer,
    `provider.${provider}.${method.toLowerCase()}`,
    {
      provider,
      'http.request.method': method,
      'url.path': sanitizePath(path),
      ...attributes,
    },
    run,
    SpanKind.CLIENT
  );
}
