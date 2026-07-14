const BACKSTAGE_INGEST_POLL_INTERVAL_MS = 1000;
const BACKSTAGE_INGEST_POLL_REQUEST_TIMEOUT_MS = 15_000;
const BACKSTAGE_INGEST_POLL_TIMEOUT_MS = 20 * 60 * 1000;

type BackstageIngestJobResponse =
  | { state: 'processing' }
  | { state: 'completed'; result: string }
  | { state: 'failed'; reason: string };

export async function pollBackstageIngestJob(
  jobUrl: string,
  uploadToken: string,
  options: {
    fetchImpl?: typeof fetch;
    errorMessageTerminator?: '' | '.';
  } = {}
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const errorMessageTerminator = options.errorMessageTerminator ?? '';
  const deadline = Date.now() + BACKSTAGE_INGEST_POLL_TIMEOUT_MS;

  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the Backstage ingest job to complete${errorMessageTerminator}`
      );
    }

    let response: Response;
    try {
      response = await fetchImpl(jobUrl, {
        headers: { Authorization: `Bearer ${uploadToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(BACKSTAGE_INGEST_POLL_REQUEST_TIMEOUT_MS),
      });
    } catch {
      await Bun.sleep(BACKSTAGE_INGEST_POLL_INTERVAL_MS);
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Backstage ingest job polling failed (${response.status} ${response.statusText})${errorMessageTerminator}`
      );
    }

    const job = (await response.json()) as BackstageIngestJobResponse;
    if (job.state === 'completed') {
      if (typeof job.result !== 'string' || !job.result.trim()) {
        throw new Error(
          `Completed Backstage ingest job did not return a signed result${errorMessageTerminator}`
        );
      }
      return job.result;
    }
    if (job.state === 'failed') {
      throw new Error(`Backstage ingest job failed: ${job.reason}`);
    }
    if (job.state !== 'processing') {
      throw new Error(`Backstage ingest job returned an unexpected state: ${String(job.state)}`);
    }

    await Bun.sleep(BACKSTAGE_INGEST_POLL_INTERVAL_MS);
  }
}
