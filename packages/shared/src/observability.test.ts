import { describe, expect, it } from 'bun:test';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { classifyHttpOperationOutcome, withObservedSpan } from './observability';

describe('observability', () => {
  it('classifies HTTP outcomes for analytics grouping', () => {
    expect(classifyHttpOperationOutcome(200)).toBe('success');
    expect(classifyHttpOperationOutcome(302)).toBe('redirect');
    expect(classifyHttpOperationOutcome(404)).toBe('client_error');
    expect(classifyHttpOperationOutcome(503)).toBe('server_error');
  });

  it('adds operation taxonomy and success outcome to completed spans', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer('test');

    await withObservedSpan(
      tracer,
      'provider.vrchat.get',
      {
        'app.operation.type': 'provider.request',
        provider: 'vrchat',
      },
      async () => 'ok',
      SpanKind.CLIENT
    );

    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes['app.operation.name']).toBe('provider.vrchat.get');
    expect(span?.attributes['app.operation.kind']).toBe('client');
    expect(span?.attributes['app.operation.type']).toBe('provider.request');
    expect(span?.attributes['app.operation.outcome']).toBe('success');
  });

  it('marks failed spans with error outcome and error type', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer('test');

    await expect(
      withObservedSpan(
        tracer,
        'api.checkout.session',
        {
          'app.operation.type': 'api.operation',
        },
        async () => {
          throw new TypeError('boom');
        },
        SpanKind.INTERNAL
      )
    ).rejects.toThrow('boom');

    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes['app.operation.outcome']).toBe('error');
    expect(span?.attributes['error.type']).toBe('TypeError');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });
});
