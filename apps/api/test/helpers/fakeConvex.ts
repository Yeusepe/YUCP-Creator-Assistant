interface ConvexCall {
  kind: 'query' | 'mutation' | 'action';
  path: string;
  args: Record<string, unknown>;
}

type ConvexHandler = (
  args: Record<string, unknown>,
  call: ConvexCall
) => Promise<unknown> | unknown;

export interface FakeConvexOptions {
  query?: Record<string, ConvexHandler>;
  mutation?: Record<string, ConvexHandler>;
  action?: Record<string, ConvexHandler>;
}

export interface FakeConvexHandle {
  url: string;
  stop(): void;
  clearCalls(): void;
  getCalls(path?: string): ConvexCall[];
}

function success(value: unknown): Response {
  return Response.json({ status: 'success', value, logLines: [] });
}

function failure(message: string, status = 500): Response {
  return new Response(JSON.stringify({ status: 'error', errorMessage: message, logLines: [] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function startFakeConvexServer(options: FakeConvexOptions = {}): FakeConvexHandle {
  const calls: ConvexCall[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const kind =
        url.pathname === '/api/query'
          ? 'query'
          : url.pathname === '/api/mutation'
            ? 'mutation'
            : url.pathname === '/api/action'
              ? 'action'
              : null;

      if (!kind) {
        return new Response('Not found', { status: 404 });
      }

      let payload: { path?: string; args?: unknown[] };
      try {
        payload = (await request.json()) as typeof payload;
      } catch {
        return failure('Invalid JSON body', 400);
      }

      const path = typeof payload.path === 'string' ? payload.path : '';
      const args =
        payload.args && payload.args.length > 0 && typeof payload.args[0] === 'object'
          ? ((payload.args[0] as Record<string, unknown>) ?? {})
          : {};

      const call: ConvexCall = { kind, path, args };
      calls.push(call);

      const handler = options[kind]?.[path];
      if (!handler) {
        return failure(`Unhandled fake Convex ${kind}: ${path}`);
      }

      try {
        const result = await handler(args, call);
        return success(result);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop() {
      server.stop(true);
    },
    clearCalls() {
      calls.length = 0;
    },
    getCalls(path?: string) {
      return path ? calls.filter((call) => call.path === path) : [...calls];
    },
  };
}
