export interface WaitForMinioReadyOptions {
  endpoint: string;
  fetch?: (url: string) => Promise<Response>;
  sleep?: (delay: number) => Promise<void>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function waitForMinioReady({
  endpoint,
  fetch: request = globalThis.fetch,
  sleep = delay,
}: WaitForMinioReadyOptions): Promise<void> {
  // Readiness probe: https://docs.min.io/aistor/operations/monitoring/healthcheck-probe/
  const deadline = Date.now() + 60_000;
  const readinessUrl = `${endpoint.replace(/\/$/, '')}/minio/health/ready`;
  let lastFailure = 'no response';
  let retryDelay = 100;

  while (Date.now() < deadline) {
    try {
      const response = await request(readinessUrl);
      if (response.ok) {
        return;
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await sleep(Math.min(retryDelay, remaining));
      retryDelay = Math.min(retryDelay * 2, 1_000);
    }
  }

  throw new Error(`MinIO did not become ready within 60 seconds. Last probe: ${lastFailure}`);
}
