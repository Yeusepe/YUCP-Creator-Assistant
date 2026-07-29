// Backblaze B2 signals rate limiting with 503 SlowDown on the S3-compatible API
// (429 on the native API), optionally with a Retry-After header in seconds, and
// recommends exponential backoff starting at one second when the header is absent.
// https://www.backblaze.com/docs/cloud-storage-integration-checklist
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const MAX_RETRY_AFTER_MS = 4_000;

function isSlowDownStatus(status: number): boolean {
  return status === 429 || status === 503;
}

// Equal jitter: at least half the schedule delay, so backoff is always real,
// plus a random half so parallel workers stop waking in synchronized bursts.
function jitteredDelayMs(delayMs: number): number {
  const half = Math.floor(delayMs / 2);
  return half + Math.floor(Math.random() * (half + 1));
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export async function fetchWithSlowDownBackoff(
  attempt: () => Promise<Response>,
  retryDelaysMs: readonly number[] = RETRY_DELAYS_MS
): Promise<Response> {
  for (let index = 0; ; index += 1) {
    const delayMs = retryDelaysMs[index];
    let response: Response;
    try {
      response = await attempt();
    } catch (error) {
      // Network and timeout failures are as transient as SlowDown responses;
      // rethrowing only after the schedule keeps them from surfacing as
      // authentication failures at the request boundary.
      if (delayMs === undefined) {
        throw error;
      }
      await sleep(jitteredDelayMs(delayMs));
      continue;
    }
    if (!isSlowDownStatus(response.status) || delayMs === undefined) {
      return response;
    }
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
    const waitMs =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? Math.min(retryAfterSeconds * 1_000, MAX_RETRY_AFTER_MS)
        : jitteredDelayMs(delayMs);
    await response.body?.cancel();
    await sleep(waitMs);
  }
}
