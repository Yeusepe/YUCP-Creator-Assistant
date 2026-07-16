export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_RETRY_BACKOFF_BASE_MS = 30_000;
export const DEFAULT_RETRY_BACKOFF_FACTOR = 2;
export const DEFAULT_RETRY_BACKOFF_CAP_MS = 60 * 60 * 1000;

export interface RetryPolicyOptions {
  maxAttempts?: number;
  retryBackoffBaseMs?: number;
  retryBackoffFactor?: number;
  retryBackoffCapMs?: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  retryBackoffBaseMs: number;
  retryBackoffFactor: number;
  retryBackoffCapMs: number;
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

export function resolveRetryPolicy(options: RetryPolicyOptions = {}): RetryPolicy {
  const policy: RetryPolicy = {
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    retryBackoffBaseMs: options.retryBackoffBaseMs ?? DEFAULT_RETRY_BACKOFF_BASE_MS,
    retryBackoffFactor: options.retryBackoffFactor ?? DEFAULT_RETRY_BACKOFF_FACTOR,
    retryBackoffCapMs: options.retryBackoffCapMs ?? DEFAULT_RETRY_BACKOFF_CAP_MS,
  };

  requirePositiveSafeInteger(policy.maxAttempts, 'maxAttempts');
  requirePositiveSafeInteger(policy.retryBackoffBaseMs, 'retryBackoffBaseMs');
  requirePositiveSafeInteger(policy.retryBackoffCapMs, 'retryBackoffCapMs');
  if (!Number.isFinite(policy.retryBackoffFactor) || policy.retryBackoffFactor <= 1) {
    throw new RangeError('retryBackoffFactor must be a finite number greater than 1');
  }
  if (policy.retryBackoffCapMs < policy.retryBackoffBaseMs) {
    throw new RangeError('retryBackoffCapMs must be greater than or equal to retryBackoffBaseMs');
  }

  return policy;
}

export function retryBackoffMs(attempts: number, policy: RetryPolicy): number {
  requirePositiveSafeInteger(attempts, 'attempts');
  const delay = policy.retryBackoffBaseMs * policy.retryBackoffFactor ** (attempts - 1);
  return Math.min(policy.retryBackoffCapMs, delay);
}
