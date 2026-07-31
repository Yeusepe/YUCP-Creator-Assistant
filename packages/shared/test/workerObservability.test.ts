import { describe, expect, it } from 'bun:test';
import { type WorkerSpanLike, withWorkerSpan } from '../src/workerObservability';

describe('worker observability', () => {
  it('records operation, response, and outcome attributes on a traced response', async () => {
    const attributes: Record<string, string | number | boolean | undefined> = {};
    const context = {
      tracing: {
        enterSpan<T>(_: string, callback: (span: WorkerSpanLike) => T): T {
          return callback({
            setAttribute(key, value) {
              attributes[key] = value;
            },
          });
        },
      },
    };

    const response = await withWorkerSpan(
      context,
      'worker.delivery.request',
      { 'app.operation.name': 'worker.delivery.request', 'http.route': '/v2/delivery' },
      async () => new Response(null, { status: 502 })
    );

    expect(response.status).toBe(502);
    expect(attributes['app.operation.name']).toBe('worker.delivery.request');
    expect(attributes['http.route']).toBe('/v2/delivery');
    expect(attributes['http.response.status_code']).toBe(502);
    expect(attributes['app.operation.outcome']).toBe('server_error');
    expect(attributes['event.name']).toBe('http.server.error');
    expect(attributes['error.type']).toBe('HttpServerError');
  });

  it('records error type before rethrowing an unexpected failure', async () => {
    const attributes: Record<string, string | number | boolean | undefined> = {};
    const context = {
      tracing: {
        enterSpan<T>(_: string, callback: (span: WorkerSpanLike) => T): T {
          return callback({
            setAttribute(key, value) {
              attributes[key] = value;
            },
          });
        },
      },
    };

    await expect(
      withWorkerSpan(context, 'worker.materialization.request', {}, async () => {
        throw new TypeError('unexpected failure');
      })
    ).rejects.toThrow('unexpected failure');
    expect(attributes['app.operation.outcome']).toBe('error');
    expect(attributes['error.type']).toBe('TypeError');
    expect(attributes['event.name']).toBe('exception');
    expect(attributes['error.message']).toBe('unexpected failure');
  });
});
