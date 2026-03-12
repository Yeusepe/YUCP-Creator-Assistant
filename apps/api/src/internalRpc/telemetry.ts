import { createLogger } from '@yucp/shared';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
const MAX_SAMPLES = 200;
const LOG_EVERY = 25;

type MethodSample = {
  count: number;
  errorCount: number;
  requestBytes: number;
  responseBytes: number;
  durationsMs: number[];
};

function percentile(samples: number[], ratio: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return Number(sorted[index]?.toFixed(2) ?? 0);
}

export class InternalRpcTelemetry {
  private readonly methods = new Map<string, MethodSample>();

  observe(params: {
    method: string;
    requestBytes?: number;
    responseBytes?: number;
    durationMs: number;
    error?: unknown;
  }): void {
    const current =
      this.methods.get(params.method) ??
      ({
        count: 0,
        errorCount: 0,
        requestBytes: 0,
        responseBytes: 0,
        durationsMs: [],
      } satisfies MethodSample);

    current.count += 1;
    current.requestBytes += params.requestBytes ?? 0;
    current.responseBytes += params.responseBytes ?? 0;
    if (params.error) current.errorCount += 1;

    current.durationsMs.push(params.durationMs);
    if (current.durationsMs.length > MAX_SAMPLES) {
      current.durationsMs.shift();
    }

    this.methods.set(params.method, current);

    if (params.error || current.count === 1 || current.count % LOG_EVERY === 0) {
      logger.info('Internal RPC method telemetry', {
        method: params.method,
        count: current.count,
        errorCount: current.errorCount,
        p50Ms: percentile(current.durationsMs, 0.5),
        p95Ms: percentile(current.durationsMs, 0.95),
        avgRequestBytes:
          current.count > 0 ? Math.round(current.requestBytes / current.count) : undefined,
        avgResponseBytes:
          current.count > 0 ? Math.round(current.responseBytes / current.count) : undefined,
      });
    }
  }
}
