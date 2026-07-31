export type WorkerSpanAttribute = string | number | boolean | undefined;

export interface WorkerSpanLike {
  isTraced?: boolean;
  setAttribute(key: string, value: WorkerSpanAttribute): void;
}

export interface WorkerTracingLike {
  enterSpan<T>(name: string, callback: (span: WorkerSpanLike) => T): T;
}

export interface WorkerExecutionContextLike {
  tracing?: WorkerTracingLike;
}

export async function withWorkerSpan<T>(
  context: WorkerExecutionContextLike | undefined,
  name: string,
  attributes: Record<string, WorkerSpanAttribute>,
  run: () => Promise<T>
): Promise<T> {
  const tracing = context?.tracing;
  if (!tracing) {
    return run();
  }

  return tracing.enterSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value);
    }

    try {
      const result = await run();
      if (result instanceof Response) {
        span.setAttribute('http.response.status_code', result.status);
        span.setAttribute(
          'app.operation.outcome',
          result.status >= 500 ? 'server_error' : result.status >= 400 ? 'client_error' : 'success'
        );
        if (result.status >= 500) {
          span.setAttribute('event.name', 'http.server.error');
          span.setAttribute('error.type', 'HttpServerError');
          span.setAttribute('error.message', `HTTP ${result.status}`);
        }
      }
      return result;
    } catch (error) {
      span.setAttribute('app.operation.outcome', 'error');
      span.setAttribute('error.type', error instanceof Error ? error.name : 'Error');
      span.setAttribute('event.name', 'exception');
      span.setAttribute('error.message', error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  });
}
