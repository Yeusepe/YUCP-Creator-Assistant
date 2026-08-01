import {
  resolveJobCouplingLane,
  type CouplingJobFile,
} from '../storage-core/couplingLane';

const DISPATCH_CLOCK_SKEW_SECONDS = 5 * 60;
const DISPATCH_BATCH_LIMIT = 100;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

export type MaterializationDispatchEntry = {
  cacheAffinityKey: string;
  // Present when the source version's protected files are all worker-lane AND
  // their aggregate codec cost fits the in-isolate budget; the materializer
  // then couples in-isolate without a container.
  couplingMode?: 'worker';
  jobId: string;
  lane: 'large' | 'maintenance';
  traceId: string;
};

export type MaterializationDispatchResult = {
  accepted: boolean;
  errorCode?: string;
  jobId: string;
};

export type MaterializationDispatchOutboxRepository = {
  claim(limit: number): Promise<MaterializationDispatchEntry[]>;
  markAccepted(jobIds: string[]): Promise<void>;
  markFailed(entries: Array<{ errorCode: string; jobId: string }>): Promise<void>;
};

function dispatchInput(timestamp: string, body: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const result = new Uint8Array(prefix.byteLength + body.byteLength);
  result.set(prefix);
  result.set(body, prefix.byteLength);
  return result;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function createMaterializationDispatchSignature(input: {
  body: Uint8Array;
  secret: string;
  timestamp: string;
}): Promise<string> {
  if (Buffer.byteLength(input.secret, 'utf8') < 32 || !/^\d{10}$/.test(input.timestamp)) {
    throw new Error('Materialization dispatch signing input is invalid');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign']
  );
  const encodedInput = dispatchInput(input.timestamp, input.body);
  const signingInput = new Uint8Array(encodedInput.byteLength);
  signingInput.set(encodedInput);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, signingInput)).toString('hex');
}

export async function verifyMaterializationDispatchSignature(input: {
  body: Uint8Array;
  nowSeconds: number;
  secret: string;
  signature: string;
  timestamp: string;
}): Promise<boolean> {
  if (
    !Number.isSafeInteger(input.nowSeconds) ||
    !/^\d{10}$/.test(input.timestamp) ||
    !HEX_SHA256.test(input.signature) ||
    Math.abs(input.nowSeconds - Number(input.timestamp)) > DISPATCH_CLOCK_SKEW_SECONDS
  ) {
    return false;
  }
  let expected: string;
  try {
    expected = await createMaterializationDispatchSignature(input);
  } catch {
    return false;
  }
  return constantTimeEqual(Buffer.from(expected, 'hex'), Buffer.from(input.signature, 'hex'));
}

export async function relayMaterializationDispatchOutbox(input: {
  dispatch: (entries: MaterializationDispatchEntry[]) => Promise<MaterializationDispatchResult[]>;
  repository: MaterializationDispatchOutboxRepository;
}): Promise<{ accepted: number; attempted: number; failed: number }> {
  const entries = await input.repository.claim(DISPATCH_BATCH_LIMIT);
  if (entries.length > DISPATCH_BATCH_LIMIT) {
    throw new Error('Materialization dispatch claim exceeded its limit');
  }
  if (entries.length === 0) {
    return { accepted: 0, attempted: 0, failed: 0 };
  }
  let results: MaterializationDispatchResult[];
  try {
    results = await input.dispatch(entries);
  } catch (error) {
    await input.repository.markFailed(
      entries.map((entry) => ({
        errorCode: 'dispatch_transport_failed',
        jobId: entry.jobId,
      }))
    );
    throw error;
  }
  const requested = new Set(entries.map((entry) => entry.jobId));
  if (
    results.length !== entries.length ||
    new Set(results.map((entry) => entry.jobId)).size !== results.length ||
    results.some((entry) => !requested.has(entry.jobId))
  ) {
    throw new Error('Materialization dispatch response is invalid');
  }
  const accepted = results.filter((entry) => entry.accepted).map((entry) => entry.jobId);
  const failed = results
    .filter((entry) => !entry.accepted)
    .map((entry) => ({
      errorCode: entry.errorCode?.trim() || 'dispatch_rejected',
      jobId: entry.jobId,
    }));
  if (accepted.length > 0) {
    await input.repository.markAccepted(accepted);
  }
  if (failed.length > 0) {
    await input.repository.markFailed(failed);
  }
  return {
    accepted: accepted.length,
    attempted: entries.length,
    failed: failed.length,
  };
}

export class PostgresMaterializationDispatchOutboxRepository
  implements MaterializationDispatchOutboxRepository
{
  constructor(private readonly sql: CatalogDatabase) {}

  async claim(limit: number): Promise<MaterializationDispatchEntry[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > DISPATCH_BATCH_LIMIT) {
      throw new Error('Materialization dispatch claim limit is invalid');
    }
    return await this.sql.begin(async (transaction) => {
      await transaction`
        UPDATE materialization_dispatch_outbox
        SET
          state = 'RETRY',
          last_error_code = 'dispatch_claim_expired',
          next_attempt_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE
          state = 'DISPATCHING'
          AND updated_at < clock_timestamp() - interval '5 minutes'
      `;
      const rows = await transaction<
        Array<{
          cacheAffinityKey: Buffer;
          jobId: string;
          lane: 'large' | 'maintenance';
          traceId: string;
        }>
      >`
        SELECT
          cache_affinity_key AS "cacheAffinityKey",
          job_id AS "jobId",
          lane,
          trace_id AS "traceId"
        FROM materialization_dispatch_claim(${limit})
      `;
      if (rows.length === 0) {
        return [];
      }
      // Pure worker-lane packages skip container allocation entirely: the mode is
      // derived from the ingest-stamped coupling lanes on the source version, so a
      // client can never influence it.
      const laneRows = await transaction<
        Array<{
          jobId: string;
          protectedFiles: CouplingJobFile[] | null;
        }>
      >`
        SELECT
          j.id AS "jobId",
          v.protected_files AS "protectedFiles"
        FROM materialization_jobs j
        JOIN package_versions v ON v.id = j.source_version_id
        WHERE j.id IN ${transaction(rows.map((row) => row.jobId))}
      `;
      // Workers only: a job routes to the worker lane whenever every file is
      // individually worker-eligible, regardless of job size. The container
      // lane is not a routing target; it remains only as the legacy path for
      // files that cannot run in an isolate at all.
      const workerLaneJobs = new Set(
        laneRows
          .filter(
            (row) =>
              Array.isArray(row.protectedFiles) &&
              resolveJobCouplingLane(row.protectedFiles) === 'worker'
          )
          .map((row) => row.jobId)
      );
      return rows.map((row) => ({
        cacheAffinityKey: Buffer.from(row.cacheAffinityKey).toString('hex'),
        ...(workerLaneJobs.has(row.jobId) ? { couplingMode: 'worker' as const } : {}),
        jobId: row.jobId,
        lane: row.lane,
        traceId: row.traceId,
      }));
    });
  }

  async markAccepted(jobIds: string[]): Promise<void> {
    if (jobIds.length < 1 || jobIds.length > DISPATCH_BATCH_LIMIT) {
      throw new Error('Materialization accepted dispatch batch is invalid');
    }
    await this.sql`
      UPDATE materialization_dispatch_outbox
      SET
        state = 'DISPATCHED',
        dispatched_at = clock_timestamp(),
        last_error_code = NULL,
        updated_at = clock_timestamp()
      WHERE
        job_id IN ${this.sql(jobIds)}
        AND state = 'DISPATCHING'
    `;
  }

  async markFailed(entries: Array<{ errorCode: string; jobId: string }>): Promise<void> {
    if (entries.length < 1 || entries.length > DISPATCH_BATCH_LIMIT) {
      throw new Error('Materialization failed dispatch batch is invalid');
    }
    await this.sql.begin(async (transaction) => {
      for (const entry of entries) {
        await transaction`
          UPDATE materialization_dispatch_outbox
          SET
            state = 'RETRY',
            last_error_code = ${entry.errorCode.slice(0, 128)},
            next_attempt_at =
              clock_timestamp()
              + LEAST(300, POWER(2, LEAST(attempts, 8))) * interval '1 second',
            updated_at = clock_timestamp()
          WHERE job_id = ${entry.jobId} AND state = 'DISPATCHING'
        `;
      }
    });
  }
}

function validateDispatchUrl(value: string): URL {
  const url = new URL(value);
  const loopback =
    url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !loopback) ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== '/v1/materialization/dispatch'
  ) {
    throw new Error('Cloudflare materialization dispatch URL is invalid');
  }
  return url;
}

export class CloudflareMaterializationDispatcher {
  private readonly dispatchUrl: URL;
  private readonly fetchFn: typeof fetch;
  private readonly secret: string;

  constructor(input: {
    dispatchUrl: string;
    fetchFn?: typeof fetch;
    secret: string;
  }) {
    this.dispatchUrl = validateDispatchUrl(input.dispatchUrl);
    if (Buffer.byteLength(input.secret, 'utf8') < 32) {
      throw new Error('Cloudflare materialization dispatch secret is invalid');
    }
    this.fetchFn = input.fetchFn ?? fetch;
    this.secret = input.secret;
  }

  async dispatch(
    entries: MaterializationDispatchEntry[]
  ): Promise<MaterializationDispatchResult[]> {
    if (entries.length < 1 || entries.length > DISPATCH_BATCH_LIMIT) {
      throw new Error('Cloudflare materialization dispatch batch is invalid');
    }
    const body = new TextEncoder().encode(
      JSON.stringify({
        jobs: entries.map((entry) => ({
          cacheAffinityKey: entry.cacheAffinityKey,
          ...(entry.couplingMode ? { couplingMode: entry.couplingMode } : {}),
          jobId: entry.jobId,
          lane: entry.lane,
          traceId: entry.traceId,
        })),
      })
    );
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const signature = await createMaterializationDispatchSignature({
      body,
      secret: this.secret,
      timestamp,
    });
    const response = await this.fetchFn(this.dispatchUrl, {
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-YUCP-Dispatch-Signature': signature,
        'X-YUCP-Dispatch-Timestamp': timestamp,
      },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Cloudflare materialization dispatch failed with status ${response.status}`);
    }
    const declaredLength = response.headers.get('content-length');
    if (declaredLength && Number(declaredLength) > 1024 * 1024) {
      throw new Error('Cloudflare materialization dispatch response is too large');
    }
    const payload = (await response.json()) as {
      results?: MaterializationDispatchResult[];
    };
    if (!Array.isArray(payload.results)) {
      throw new Error('Cloudflare materialization dispatch response is invalid');
    }
    return payload.results;
  }
}

export function startMaterializationDispatchRelay(input: {
  dispatcher: CloudflareMaterializationDispatcher;
  intervalMs?: number;
  onEvent?: ((event: Record<string, unknown>) => void) | undefined;
  repository: PostgresMaterializationDispatchOutboxRepository;
}): { runOnce(): Promise<void>; stop(): void } {
  const intervalMs = input.intervalMs ?? 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000) {
    throw new Error('Materialization dispatch relay interval is invalid');
  }
  let active: Promise<void> | null = null;
  const runOnce = async () => {
    if (active) {
      return await active;
    }
    active = relayMaterializationDispatchOutbox({
      dispatch: (entries) => input.dispatcher.dispatch(entries),
      repository: input.repository,
    })
      .then((result) => {
        if (result.attempted > 0) {
          input.onEvent?.({
            ...result,
            event: 'materialization.dispatch.relay',
          });
        }
      })
      .catch(() => {
        input.onEvent?.({
          errorCode: 'materialization_dispatch_relay_failed',
          event: 'materialization.dispatch.relay_failed',
        });
      })
      .finally(() => {
        active = null;
      });
    return await active;
  };
  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref?.();
  void runOnce();
  return {
    runOnce,
    stop() {
      clearInterval(timer);
    },
  };
}

import type { CatalogDatabase } from '../catalog';
