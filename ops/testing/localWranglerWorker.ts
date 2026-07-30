import { type Binding, unstable_startWorker } from 'wrangler';

export type LocalWranglerWorker = {
  baseUrl: string;
  dispatch: (request: Request) => Promise<Response>;
  stop: () => Promise<void>;
};

function plainTextBindings(vars: Readonly<Record<string, string>>): Record<string, Binding> {
  return Object.fromEntries(
    Object.entries(vars).map(([name, value]) => [
      name,
      {
        type: 'plain_text' as const,
        value,
      },
    ])
  );
}

export async function startLocalWranglerWorker(input: {
  config: string;
  entrypoint: string;
  onStructuredLog?: (log: unknown) => void;
  port: number;
  vars: Readonly<Record<string, string>>;
}): Promise<LocalWranglerWorker> {
  // The dev supervisor exports YUCP_WRANGLER_PERSIST_PATH so every spawned worker and the
  // local R2 storage mirror share one wrangler persistence root (like `wrangler dev
  // --persist-to`). Without it, state stays in-memory as before.
  const persistPath = process.env.YUCP_WRANGLER_PERSIST_PATH?.trim();
  const worker = await unstable_startWorker({
    bindings: plainTextBindings(input.vars),
    config: input.config,
    dev: {
      inspector: false,
      logLevel: 'none',
      persist: persistPath || false,
      remote: false,
      server: {
        hostname: '127.0.0.1',
        port: input.port,
      },
      structuredLogsHandler: input.onStructuredLog,
      watch: false,
    },
    entrypoint: input.entrypoint,
    sendMetrics: false,
  });
  try {
    await worker.ready;
    const workerUrl = await worker.url;
    let stopped = false;
    return {
      baseUrl: workerUrl.toString(),
      async dispatch(request) {
        const body =
          request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : Buffer.from(await request.arrayBuffer());
        const response = await worker.fetch(request.url, {
          ...(body ? { body } : {}),
          headers: Object.fromEntries(request.headers.entries()),
          method: request.method,
          redirect: 'manual',
        });
        return response as unknown as Response;
      },
      async stop() {
        if (stopped) {
          return;
        }
        stopped = true;
        await worker.dispose();
      },
    };
  } catch (error) {
    await worker.dispose();
    throw error;
  }
}
