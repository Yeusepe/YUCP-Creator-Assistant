export class ProviderRateLimitError extends Error {
  constructor(
    public readonly providerName: string,
    public readonly waitMs: number,
    message = `${providerName} rate limited`
  ) {
    super(message);
    this.name = 'ProviderRateLimitError';
  }
}

export interface ProviderRateLimitRetryContext {
  readonly providerName: string;
  readonly retries: number;
  readonly waitMs: number;
  readonly error: ProviderRateLimitError;
}

export interface WithProviderRateLimitRetriesOptions<T> {
  readonly providerName: string;
  readonly operation: () => Promise<T>;
  readonly getRateLimitError: (error: unknown) => ProviderRateLimitError | null;
  readonly onRetry?: (context: ProviderRateLimitRetryContext) => void | Promise<void>;
  readonly maxRetries?: number;
  readonly sleep?: (waitMs: number) => Promise<void>;
}

function sleep(waitMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

export function parseRetryAfterMs(retryAfter: string | null, fallbackMs: number): number {
  if (!retryAfter) return fallbackMs;

  const parsedSeconds = Number.parseInt(retryAfter, 10);
  return Number.isFinite(parsedSeconds) && parsedSeconds >= 0 ? parsedSeconds * 1000 : fallbackMs;
}

export function detectProviderRateLimitError(
  error: unknown,
  options: { providerName: string; fallbackWaitMs: number }
): ProviderRateLimitError | null {
  if (error instanceof ProviderRateLimitError) return error;
  if (!(error instanceof Error)) return null;

  const normalizedMessage = error.message.toLowerCase();
  if (!normalizedMessage.includes('429') && !normalizedMessage.includes('rate limit')) {
    return null;
  }

  return new ProviderRateLimitError(options.providerName, options.fallbackWaitMs, error.message);
}

export async function withProviderRateLimitRetries<T>(
  options: WithProviderRateLimitRetriesOptions<T>
): Promise<T> {
  const maxRetries = options.maxRetries ?? 10;
  const sleepFn = options.sleep ?? sleep;
  let retries = 0;

  while (true) {
    try {
      return await options.operation();
    } catch (error) {
      const rateLimitError = options.getRateLimitError(error);
      if (!rateLimitError) {
        throw error;
      }

      if (retries >= maxRetries) {
        throw new Error(`${options.providerName} rate limit exceeded after ${maxRetries} retries`);
      }

      await options.onRetry?.({
        providerName: options.providerName,
        retries,
        waitMs: rateLimitError.waitMs,
        error: rateLimitError,
      });

      retries += 1;
      await sleepFn(rateLimitError.waitMs);
    }
  }
}
