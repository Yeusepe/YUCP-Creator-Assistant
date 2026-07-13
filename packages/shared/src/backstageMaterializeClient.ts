import {
  type BackstageMaterializeClaims,
  type BackstageMaterializeResult,
  parseMaterializePollClaims,
  parseMaterializeResult,
  sign,
  verify,
} from './backstageIngest';
import { assertSecureLoreUrl } from './loreBackstageClient';

const BACKSTAGE_MATERIALIZE_REQUEST_TIMEOUT_MS = 5_000;
const BACKSTAGE_MATERIALIZE_POLL_INTERVAL_MS = 500;
const BACKSTAGE_MATERIALIZE_DEADLINE_MS = 120_000;

export class BackstageMaterializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackstageMaterializeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimTrailingForwardSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function materializeRequestSignal(deadline: number): AbortSignal {
  return AbortSignal.timeout(
    Math.max(1, Math.min(BACKSTAGE_MATERIALIZE_REQUEST_TIMEOUT_MS, deadline - Date.now()))
  );
}

async function parseMaterializeJsonResponse(
  response: Response,
  operation: string
): Promise<unknown> {
  if (!response.ok) {
    throw new BackstageMaterializeError(
      `${operation} failed (${response.status} ${response.statusText})`
    );
  }
  try {
    return await response.json();
  } catch {
    throw new BackstageMaterializeError(`${operation} returned invalid JSON`);
  }
}

export function isFetchAbortOrTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const name = error.name.trim().toLowerCase();
  if (name === 'aborterror' || name === 'timeouterror') {
    return true;
  }
  const message = error.message.trim().toLowerCase();
  return message.includes('aborted') || message.includes('timed out');
}

export async function runBackstageMaterialize(input: {
  ingestBaseUrl: string;
  ingestSecret: string;
  claims: BackstageMaterializeClaims;
  fetchImpl?: typeof fetch;
  deadlineMs?: number;
  pollIntervalMs?: number;
}): Promise<BackstageMaterializeResult> {
  if (!input.ingestSecret || !input.ingestBaseUrl) {
    throw new BackstageMaterializeError('Backstage ingest service is not configured');
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const pollIntervalMs = input.pollIntervalMs ?? BACKSTAGE_MATERIALIZE_POLL_INTERVAL_MS;
  const ingestBaseUrl = trimTrailingForwardSlashes(
    assertSecureLoreUrl(input.ingestBaseUrl, 'LORE_INGEST_BASE_URL').toString()
  );
  const materializeToken = await sign(input.ingestSecret, input.claims);
  const deadline = Date.now() + (input.deadlineMs ?? BACKSTAGE_MATERIALIZE_DEADLINE_MS);

  let enqueueResponse: Response;
  try {
    enqueueResponse = await fetchImpl(`${ingestBaseUrl}/materialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: materializeToken }),
      signal: materializeRequestSignal(deadline),
    });
  } catch (error) {
    throw new BackstageMaterializeError(
      `Backstage materialize request failed: ${
        isFetchAbortOrTimeoutError(error) ? 'request timed out' : 'sidecar unavailable'
      }`
    );
  }
  const enqueuePayload = await parseMaterializeJsonResponse(
    enqueueResponse,
    'Backstage materialize request'
  );
  if (
    !isRecord(enqueuePayload) ||
    typeof enqueuePayload.jobId !== 'string' ||
    typeof enqueuePayload.pollToken !== 'string'
  ) {
    throw new BackstageMaterializeError(
      'Backstage materialize request did not return a valid jobId and pollToken'
    );
  }
  const jobId = enqueuePayload.jobId.trim();
  const pollToken = enqueuePayload.pollToken.trim();
  if (!jobId || !pollToken) {
    throw new BackstageMaterializeError(
      'Backstage materialize request did not return a valid jobId and pollToken'
    );
  }
  try {
    const pollClaims = parseMaterializePollClaims(await verify(input.ingestSecret, pollToken));
    if (
      pollClaims.jobId !== jobId ||
      pollClaims.authUserId !== input.claims.authUserId ||
      pollClaims.packageId !== input.claims.packageId ||
      pollClaims.version !== input.claims.version
    ) {
      throw new Error('Materialize poll token ownership mismatch.');
    }
  } catch {
    throw new BackstageMaterializeError(
      'Backstage materialize request did not return a valid pollToken'
    );
  }
  const jobUrl = `${ingestBaseUrl}/jobs/${encodeURIComponent(jobId)}`;

  // ponytail: unitypackage shims materialize in milliseconds without downloading the raw. A
  // multi-GB .zip repack can still exceed the Worker's synchronous budget and would need the
  // async-publish handoff tracked as a follow-up.
  for (;;) {
    if (Date.now() >= deadline) {
      throw new BackstageMaterializeError('Timed out waiting for Backstage materialization');
    }

    let jobResponse: Response;
    try {
      jobResponse = await fetchImpl(jobUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${pollToken}` },
        signal: materializeRequestSignal(deadline),
      });
    } catch (error) {
      throw new BackstageMaterializeError(
        `Backstage materialize job polling failed: ${
          isFetchAbortOrTimeoutError(error) ? 'request timed out' : 'sidecar unavailable'
        }`
      );
    }
    const jobPayload = await parseMaterializeJsonResponse(
      jobResponse,
      'Backstage materialize job polling'
    );
    if (!isRecord(jobPayload)) {
      throw new BackstageMaterializeError('Backstage materialize job returned an invalid state');
    }
    if (jobPayload.state === 'completed') {
      if (typeof jobPayload.result !== 'string' || !jobPayload.result.trim()) {
        throw new BackstageMaterializeError(
          'Completed Backstage materialize job did not return a signed result'
        );
      }
      try {
        return parseMaterializeResult(await verify(input.ingestSecret, jobPayload.result));
      } catch {
        throw new BackstageMaterializeError(
          'Completed Backstage materialize job returned an invalid signed result'
        );
      }
    }
    if (jobPayload.state === 'failed') {
      const reason =
        typeof jobPayload.reason === 'string' && jobPayload.reason.trim()
          ? jobPayload.reason.trim()
          : 'unknown failure';
      throw new BackstageMaterializeError(`Backstage materialize job failed: ${reason}`);
    }
    if (jobPayload.state !== 'processing') {
      throw new BackstageMaterializeError('Backstage materialize job returned an invalid state');
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
