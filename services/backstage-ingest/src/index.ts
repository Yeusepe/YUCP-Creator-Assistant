import { FileStore } from '@tus/file-store';
import { Server } from '@tus/server';
import {
  type BackstageMaterializeClaims,
  type BackstageMaterializePollClaims,
  type BackstageMaterializeResult,
  type BackstageUploadClaims,
  type BackstageUploadResult,
  parseMaterializeClaims,
  parseMaterializePollClaims,
  parseUploadClaims,
  sign,
  validateSigningSecret,
  verify,
} from '@yucp/shared/backstageIngest';
import { MAX_BACKSTAGE_PACKAGE_BYTES } from '@yucp/shared/backstageLimits';
import {
  collectUnityPackageImportPaths,
  collectZipArchiveEntryPaths,
  materializeBackstageReleaseArtifact,
} from '@yucp/shared/backstageReleaseMaterialization';
import { detectBackstageVpmDeliverySourceKind } from '@yucp/shared/backstageVpmDelivery';
import {
  type ConfiguredLoreBackstageConfig,
  getBackstageBytesFromLore,
  loreRepositoryIdForCreator,
  putBackstageBytesToLore,
  requireLoreBackstageConfig,
  sha256ArrayBuffer,
} from '@yucp/shared/loreBackstageClient';
import type { LoreBackstageArtifactReference } from '@yucp/shared/loreBackstageDelivery';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { Redis as IORedis } from 'ioredis';

const DEFAULT_PORT = 8080;
const DEFAULT_TUS_DIRECTORY = '/data/tus';
const DEFAULT_LORE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UPLOAD_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = MAX_BACKSTAGE_PACKAGE_BYTES;
// ponytail: The 8 MiB materialize request cap remains defense in depth against oversized bodies.
const MAX_MATERIALIZE_BODY_BYTES = 8 * 1024 * 1024;
// ponytail: MAX_MANAGED_PATHS_SERIALIZED_BYTES * ~1.34 + metadata/signature overhead must stay
// below MAX_MATERIALIZE_BODY_BYTES. If very large packages need more, move the path list to
// server-side storage keyed by the upload instead of embedding it in the token.
const MAX_MANAGED_PATHS_SERIALIZED_BYTES = 4 * 1024 * 1024;
if (MAX_MANAGED_PATHS_SERIALIZED_BYTES * 2 > MAX_MATERIALIZE_BODY_BYTES) {
  throw new Error('Managed-paths payload limit must leave 2x materialize request headroom.');
}
const RESULT_TTL_SECONDS = 15 * 60;
const QUEUE_NAME = 'backstage-ingest';
const FAILED_JOB_REASON = 'ingest_failed';
const MANAGED_PATHS_PAYLOAD_TOO_LARGE_REASON =
  'Backstage package has too many or too long managed asset paths.';
const MANAGED_PATHS_PARSE_FAILED_REASON = 'managed_paths_failed';
const STAGED_READ_FAILED_REASON = 'staged_read_failed';
// ponytail: deterministic upload failures BullMQ must not retry (parsing a corrupt/bomb archive
// fails identically each attempt); a transient staged read stays retriable and is not listed here.
const UNRECOVERABLE_UPLOAD_FAILURE_REASONS = new Set<string>([
  MANAGED_PATHS_PAYLOAD_TOO_LARGE_REASON,
  MANAGED_PATHS_PARSE_FAILED_REASON,
]);

type ServiceConfig = {
  allowedOrigins: string[];
  port: number;
  tusDirectory: string;
  uploadTtlMs: number;
  ingestSecret: string;
  redisUrl: string;
  queuePrefix: string;
  concurrency: number;
  lore: ConfiguredLoreBackstageConfig;
};

type TusHookError = {
  status_code: number;
  body: string;
};

type BackstageIngestJobData = {
  uploadId: string;
  stagedPath: string;
  claims: BackstageUploadClaims;
};

type BackstageMaterializeJobData = {
  claims: BackstageMaterializeClaims;
};

type BackstageJobData = BackstageIngestJobData | BackstageMaterializeJobData;

class MaterializeRequestBodyTooLargeError extends Error {
  constructor() {
    super('Materialize request body too large');
    this.name = 'MaterializeRequestBodyTooLargeError';
  }
}

function isUploadJobData(data: BackstageJobData): data is BackstageIngestJobData {
  return 'uploadId' in data && 'stagedPath' in data;
}

async function readMaterializeRequestJson(request: Request): Promise<unknown> {
  const contentLengthHeader = request.headers.get('content-length')?.trim();
  if (!contentLengthHeader || !/^\d+$/.test(contentLengthHeader)) {
    throw new MaterializeRequestBodyTooLargeError();
  }

  const contentLength = Number(contentLengthHeader);
  if (!Number.isSafeInteger(contentLength) || contentLength > MAX_MATERIALIZE_BODY_BYTES) {
    throw new MaterializeRequestBodyTooLargeError();
  }

  const bodyBytes = await request.arrayBuffer();
  if (bodyBytes.byteLength > MAX_MATERIALIZE_BODY_BYTES) {
    throw new MaterializeRequestBodyTooLargeError();
  }
  return JSON.parse(new TextDecoder().decode(bodyBytes)) as unknown;
}

function requiredEnv(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

function optionalPositiveInteger(name: string): number | undefined {
  const value = Bun.env[name]?.trim();
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function optionalCommaSeparatedList(name: string): string[] {
  const value = Bun.env[name]?.trim();
  if (!value) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
}

function loadConfig(): ServiceConfig {
  const port = optionalPositiveInteger('PORT') ?? DEFAULT_PORT;
  if (port > 65_535) {
    throw new Error('PORT must be between 1 and 65535.');
  }

  const ingestSecret = requiredEnv('BACKSTAGE_INGEST_SECRET');
  validateSigningSecret(ingestSecret);

  return {
    allowedOrigins: optionalCommaSeparatedList('BACKSTAGE_INGEST_ALLOWED_ORIGINS'),
    port,
    tusDirectory: Bun.env.BACKSTAGE_INGEST_TUS_DIR?.trim() || DEFAULT_TUS_DIRECTORY,
    uploadTtlMs: optionalPositiveInteger('BACKSTAGE_INGEST_UPLOAD_TTL_MS') ?? DEFAULT_UPLOAD_TTL_MS,
    ingestSecret,
    redisUrl: requiredEnv('BACKSTAGE_INGEST_REDIS_URL'),
    // ponytail: the {...} is a Redis/Dragonfly hashtag so all BullMQ keys share one slot/lock (required by --lock_on_hashtags), and it namespaces the queue on a shared instance.
    queuePrefix: Bun.env.BACKSTAGE_INGEST_QUEUE_PREFIX?.trim() || '{backstage-ingest}',
    concurrency: optionalPositiveInteger('BACKSTAGE_INGEST_CONCURRENCY') ?? 1,
    lore: requireLoreBackstageConfig({
      apiBaseUrl: requiredEnv('LORE_API_BASE_URL'),
      repoNamespaceSalt: requiredEnv('LORE_REPO_NAMESPACE_SALT'),
      accessClientId: requiredEnv('LORE_ACCESS_CLIENT_ID'),
      accessClientSecret: requiredEnv('LORE_ACCESS_CLIENT_SECRET'),
      timeoutMs: optionalPositiveInteger('LORE_TIMEOUT_MS') ?? DEFAULT_LORE_TIMEOUT_MS,
    }),
  };
}

function tusError(status_code: number, body: string): TusHookError {
  return { status_code, body: `${body}\n` };
}

function isTusHookError(error: unknown): error is TusHookError {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as Partial<TusHookError>).status_code === 'number' &&
    typeof (error as Partial<TusHookError>).body === 'string'
  );
}

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}

function removeCorsWildcard(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete('Access-Control-Allow-Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function applyJobCors(request: Request, response: Response): Response {
  if (config.allowedOrigins.length === 0) {
    return removeCorsWildcard(response);
  }

  const origin = request.headers.get('origin');
  const allowedOrigin =
    origin && config.allowedOrigins.includes(origin) ? origin : config.allowedOrigins[0];
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', allowedOrigin);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function buildLoreReference(input: {
  repositoryId: string;
  stored: { address: string; sha256: string; byteSize: number };
  authUserId: string;
  uploadedAt: string;
}): LoreBackstageArtifactReference {
  return {
    repositoryId: input.repositoryId,
    address: input.stored.address,
    sha256: input.stored.sha256,
    byteSize: input.stored.byteSize,
    uploadedAt: input.uploadedAt,
    tenantId: input.authUserId,
  };
}

async function streamSha256Hex(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>) {
    hasher.update(chunk);
  }
  return hasher.digest('hex');
}

// Mirror apps/api and apps/bot: pull secrets from Infisical at startup so the container only needs
// the machine-identity creds (INFISICAL_PROJECT_ID + INFISICAL_CLIENT_ID/SECRET). fetchInfisicalSecrets
// returns {} when those are absent, so local dev / the integration test (which inject env directly)
// are unaffected. Explicit container env wins; Infisical only fills gaps.
async function hydrateEnvFromInfisical(): Promise<void> {
  try {
    const { fetchInfisicalSecrets } = await import('@yucp/shared/infisical/fetchSecrets');
    const secrets = await fetchInfisicalSecrets();
    let applied = 0;
    for (const [key, value] of Object.entries(secrets)) {
      if (value !== undefined && !process.env[key]?.trim()) {
        process.env[key] = value;
        applied += 1;
      }
    }
    if (applied > 0) {
      console.log(
        JSON.stringify({ event: 'backstage_ingest.infisical_hydrated', appliedCount: applied })
      );
    }
  } catch (error) {
    // ponytail: a fetch failure must not crash boot — explicit container env still works, and
    // loadConfig() below raises a clear missing-variable error if a required secret is truly absent.
    console.error(
      JSON.stringify({
        event: 'backstage_ingest.infisical_hydrate_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

await hydrateEnvFromInfisical();

const config = loadConfig();
const store = new FileStore({
  directory: config.tusDirectory,
  expirationPeriodInMilliseconds: config.uploadTtlMs,
});
// ponytail: ioredis is BullMQ's default and stable on Bun; Bun's native Redis client dropped connections on 1.3.9.
const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue<BackstageJobData, string>(QUEUE_NAME, {
  connection,
  prefix: config.queuePrefix,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 3_600 },
    removeOnFail: { age: 86_400 },
  },
});

async function processUploadJob(data: BackstageIngestJobData): Promise<string> {
  const startedAt = performance.now();
  const { claims, stagedPath, uploadId } = data;
  let bytes: ArrayBuffer;
  try {
    // ponytail: upload jobs hold about 1x source bytes in memory while deriving the install footprint; concurrency bounds aggregate memory.
    bytes = await Bun.file(stagedPath).arrayBuffer();
  } catch {
    console.error(
      JSON.stringify({
        event: 'backstage_ingest.staged_read_failed',
        uploadId,
        reason: STAGED_READ_FAILED_REASON,
        durationMs: Math.round(performance.now() - startedAt),
      })
    );
    // ponytail: reading the local staged file can fail transiently (I/O), so let BullMQ retry.
    throw new Error(STAGED_READ_FAILED_REASON);
  }

  let sourceKind: BackstageUploadResult['sourceKind'];
  let managedPaths: string[];
  try {
    const sourceBytes = new Uint8Array(bytes);
    sourceKind = detectBackstageVpmDeliverySourceKind({
      deliveryName: claims.deliveryName,
      contentType: claims.sourceContentType,
      bytes: sourceBytes,
    });
    managedPaths =
      sourceKind === 'unitypackage'
        ? Array.from(
            new Set([
              `Packages/${claims.packageId}/package.json`,
              ...collectUnityPackageImportPaths(sourceBytes),
            ])
          )
        : collectZipArchiveEntryPaths(sourceBytes);
  } catch {
    console.error(
      JSON.stringify({
        event: 'backstage_ingest.managed_paths_failed',
        uploadId,
        reason: MANAGED_PATHS_PARSE_FAILED_REASON,
        durationMs: Math.round(performance.now() - startedAt),
      })
    );
    // ponytail: archive parsing is deterministic — a corrupt or bomb archive fails identically on
    // retry, so fail fast and don't burn repeated decompression CPU.
    throw new UnrecoverableError(MANAGED_PATHS_PARSE_FAILED_REASON);
  }

  const managedPathsSerializedBytes = Buffer.byteLength(JSON.stringify(managedPaths));
  if (managedPathsSerializedBytes > MAX_MANAGED_PATHS_SERIALIZED_BYTES) {
    console.error(
      JSON.stringify({
        event: 'backstage_ingest.managed_paths_rejected',
        uploadId,
        reason: 'managed_paths_payload_too_large',
        managedPathCount: managedPaths.length,
        managedPathsSerializedBytes,
        limitBytes: MAX_MANAGED_PATHS_SERIALIZED_BYTES,
        durationMs: Math.round(performance.now() - startedAt),
      })
    );
    throw new UnrecoverableError(MANAGED_PATHS_PAYLOAD_TOO_LARGE_REASON);
  }

  let rawStored: Awaited<ReturnType<typeof putBackstageBytesToLore>>;
  try {
    rawStored = await putBackstageBytesToLore({
      config: config.lore,
      repositoryId: claims.repositoryId,
      bytes,
    });
  } catch {
    console.error(
      JSON.stringify({
        event: 'backstage_ingest.lore_source_failed',
        uploadId,
        reason: 'lore_source_put_failed',
        rawByteSize: bytes.byteLength,
        durationMs: Math.round(performance.now() - startedAt),
      })
    );
    throw new Error('lore_source_put_failed');
  }

  const loreSource = buildLoreReference({
    repositoryId: claims.repositoryId,
    stored: rawStored,
    authUserId: claims.authUserId,
    uploadedAt: new Date().toISOString(),
  });
  const result: BackstageUploadResult = {
    typ: 'backstage-upload-result',
    authUserId: claims.authUserId,
    packageId: claims.packageId,
    version: claims.version,
    loreSource,
    rawSha256: rawStored.sha256,
    rawByteSize: rawStored.byteSize,
    rawDeliveryName: claims.deliveryName,
    rawContentType: claims.sourceContentType,
    sourceKind,
    managedPaths,
    exp: Math.floor(Date.now() / 1000) + RESULT_TTL_SECONDS,
  };
  const signedResult = await sign(config.ingestSecret, result);

  console.info(
    JSON.stringify({
      event: 'backstage_ingest.upload_completed',
      uploadId,
      rawByteSize: rawStored.byteSize,
      managedPathCount: managedPaths.length,
      durationMs: Math.round(performance.now() - startedAt),
    })
  );
  return signedResult;
}

async function processMaterializeJob(
  data: BackstageMaterializeJobData,
  materializeJobId: string
): Promise<string> {
  const startedAt = performance.now();
  const { claims } = data;
  let sourceBytes: ArrayBuffer | undefined;
  if (claims.sourceKind === 'zip') {
    try {
      sourceBytes = await getBackstageBytesFromLore({
        config: config.lore,
        repositoryId: claims.repositoryId,
        address: claims.loreSourceAddress,
      });
    } catch {
      console.error(
        JSON.stringify({
          event: 'backstage_ingest.materialize_source_failed',
          materializeJobId,
          reason: 'lore_source_get_failed',
          durationMs: Math.round(performance.now() - startedAt),
        })
      );
      throw new Error('lore_source_get_failed');
    }

    if ((await sha256ArrayBuffer(sourceBytes)) !== claims.loreSourceSha256) {
      console.error(
        JSON.stringify({
          event: 'backstage_ingest.materialize_source_integrity_failed',
          materializeJobId,
          reason: 'source_integrity_failed',
          rawByteSize: sourceBytes.byteLength,
          durationMs: Math.round(performance.now() - startedAt),
        })
      );
      throw new Error('source_integrity_failed');
    }
  }

  let materialized: Awaited<ReturnType<typeof materializeBackstageReleaseArtifact>>;
  try {
    let ownedSourceBytes: Uint8Array | undefined;
    if (sourceBytes) {
      // ponytail: zip materialize jobs hold about 1x source plus 1x deliverable in memory; worker concurrency bounds aggregate memory.
      ownedSourceBytes = new Uint8Array(sourceBytes);
      const detectedSourceKind = detectBackstageVpmDeliverySourceKind({
        deliveryName: claims.deliveryName,
        contentType: claims.sourceContentType,
        bytes: ownedSourceBytes,
      });
      if (detectedSourceKind !== claims.sourceKind) {
        throw new Error('source_kind_mismatch');
      }
    }
    materialized = await materializeBackstageReleaseArtifact({
      sourceBytes: ownedSourceBytes,
      deliveryName: claims.deliveryName,
      contentType: claims.sourceContentType,
      packageId: claims.packageId,
      version: claims.version,
      displayName: claims.materializeMetadata?.displayName,
      managedPaths: claims.managedPaths,
      metadata: claims.materializeMetadata?.metadata,
    });
    if (materialized.originalSourceKind !== claims.sourceKind) {
      throw new Error('source_kind_mismatch');
    }
  } catch {
    console.error(
      JSON.stringify({
        event: 'backstage_ingest.materialize_failed',
        materializeJobId,
        reason: 'materialization_failed',
        ...(sourceBytes ? { rawByteSize: sourceBytes.byteLength } : {}),
        sourceKind: claims.sourceKind,
        managedPathCount: claims.managedPaths.length,
        durationMs: Math.round(performance.now() - startedAt),
      })
    );
    throw new Error('materialization_failed');
  }

  let deliverableStored: Awaited<ReturnType<typeof putBackstageBytesToLore>>;
  try {
    deliverableStored = await putBackstageBytesToLore({
      config: config.lore,
      repositoryId: claims.repositoryId,
      bytes: materialized.bytes,
    });
  } catch {
    console.error(
      JSON.stringify({
        event: 'backstage_ingest.materialize_delivery_failed',
        materializeJobId,
        reason: 'lore_deliverable_put_failed',
        ...(sourceBytes ? { rawByteSize: sourceBytes.byteLength } : {}),
        sourceKind: claims.sourceKind,
        deliverableByteSize: materialized.bytes.byteLength,
        durationMs: Math.round(performance.now() - startedAt),
      })
    );
    throw new Error('lore_deliverable_put_failed');
  }

  const loreDelivery = buildLoreReference({
    repositoryId: claims.repositoryId,
    stored: deliverableStored,
    authUserId: claims.authUserId,
    uploadedAt: new Date().toISOString(),
  });
  const result: BackstageMaterializeResult = {
    typ: 'backstage-materialize-result',
    authUserId: claims.authUserId,
    packageId: claims.packageId,
    version: claims.version,
    loreDelivery,
    deliverableSha256: deliverableStored.sha256,
    deliverableByteSize: deliverableStored.byteSize,
    deliverableDeliveryName: materialized.deliveryName,
    deliverableContentType: materialized.contentType,
    exp: Math.floor(Date.now() / 1000) + RESULT_TTL_SECONDS,
  };
  const signedResult = await sign(config.ingestSecret, result);

  console.info(
    JSON.stringify({
      event: 'backstage_ingest.materialize_completed',
      materializeJobId,
      ...(sourceBytes ? { rawByteSize: sourceBytes.byteLength } : {}),
      sourceKind: claims.sourceKind,
      rawDownloadSkipped: claims.sourceKind === 'unitypackage',
      deliverableByteSize: deliverableStored.byteSize,
      durationMs: Math.round(performance.now() - startedAt),
    })
  );
  return signedResult;
}

const worker = new Worker<BackstageJobData, string>(
  QUEUE_NAME,
  async (job) =>
    isUploadJobData(job.data)
      ? await processUploadJob(job.data)
      : await processMaterializeJob(job.data, job.id ?? 'unknown'),
  { connection, prefix: config.queuePrefix, concurrency: config.concurrency }
);

async function removeStagedUpload(uploadId: string | undefined): Promise<void> {
  if (!uploadId) {
    console.error(
      JSON.stringify({
        event: 'backstage_ingest.cleanup_failed',
        reason: 'cleanup_failed',
      })
    );
    return;
  }

  try {
    await store.remove(uploadId);
  } catch {
    console.error(
      JSON.stringify({
        event: 'backstage_ingest.cleanup_failed',
        uploadId,
        reason: 'cleanup_failed',
      })
    );
  }
}

async function removePermanentlyRejectedUpload(uploadId: string): Promise<void> {
  try {
    await store.remove(uploadId);
  } catch {
    console.error(
      JSON.stringify({
        event: 'backstage_ingest.rejected_upload_cleanup_failed',
        reason: 'rejected_upload_cleanup_failed',
      })
    );
  }
}

worker.on('completed', (job) => {
  if (isUploadJobData(job.data)) {
    void removeStagedUpload(job.id);
  }
});

worker.on('failed', (job) => {
  if (
    job &&
    isUploadJobData(job.data) &&
    (UNRECOVERABLE_UPLOAD_FAILURE_REASONS.has(job.failedReason ?? '') ||
      job.attemptsMade >= (job.opts.attempts ?? 1))
  ) {
    void removeStagedUpload(job.id);
  }
});

worker.on('error', () => {
  console.error(
    JSON.stringify({
      event: 'backstage_ingest.worker_error',
      reason: 'worker_error',
    })
  );
});

queue.on('error', () => {
  console.error(
    JSON.stringify({
      event: 'backstage_ingest.queue_error',
      reason: 'queue_error',
    })
  );
});

const server = new Server({
  path: '/files',
  datastore: store,
  maxSize: MAX_UPLOAD_BYTES,
  respectForwardedHeaders: true,
  allowedOrigins: config.allowedOrigins,
  async onUploadCreate(_request, upload) {
    const uploadToken = upload.metadata?.uploadToken;
    if (typeof uploadToken !== 'string' || !uploadToken) {
      throw tusError(401, 'Upload metadata must include uploadToken.');
    }

    let claims: BackstageUploadClaims;
    try {
      claims = parseUploadClaims(await verify(config.ingestSecret, uploadToken));
    } catch {
      throw tusError(401, 'Upload token is invalid or expired.');
    }

    if (claims.byteSize > MAX_UPLOAD_BYTES) {
      throw tusError(413, 'Upload token byteSize exceeds the service limit.');
    }
    if (upload.size === undefined || upload.size !== claims.byteSize) {
      throw tusError(400, 'Upload-Length must match the upload token byteSize.');
    }

    const metadata = { ...upload.metadata };
    delete metadata.uploadToken;
    return {
      metadata: {
        ...metadata,
        _claims: JSON.stringify(claims),
      },
    };
  },
  async onUploadFinish(request, upload) {
    try {
      const serializedClaims = upload.metadata?._claims;
      if (typeof serializedClaims !== 'string') {
        throw tusError(401, 'Validated upload claims are missing.');
      }

      let claims: BackstageUploadClaims;
      try {
        claims = parseUploadClaims(JSON.parse(serializedClaims));
      } catch {
        throw tusError(401, 'Validated upload claims are invalid.');
      }

      const storedUpload = upload.storage?.path ? upload : await store.getUpload(upload.id);
      const stagedPath = storedUpload.storage?.path;
      if (storedUpload.storage?.type !== 'file' || !stagedPath) {
        throw tusError(500, 'Staged upload does not have file storage metadata.');
      }

      try {
        const stagedFile = Bun.file(stagedPath);
        if (stagedFile.size !== claims.byteSize) {
          throw tusError(422, 'Uploaded byte size does not match the upload token.');
        }
        const rawSha256 = await streamSha256Hex(stagedPath);
        if (rawSha256 !== claims.declaredSha256) {
          throw tusError(422, 'Uploaded SHA-256 does not match declaredSha256.');
        }

        const repositoryId = loreRepositoryIdForCreator(
          claims.authUserId,
          config.lore.repoNamespaceSalt
        );
        if (repositoryId !== claims.repositoryId) {
          throw tusError(403, 'Upload token repositoryId does not match the authenticated tenant.');
        }
      } catch (error) {
        if (isTusHookError(error)) {
          await removePermanentlyRejectedUpload(upload.id);
        }
        throw error;
      }

      const incompleteUpload = await store.configstore.get(upload.id);
      await store.configstore.set(upload.id, upload);
      try {
        await queue.add(
          'ingest-upload',
          { uploadId: upload.id, stagedPath, claims },
          { jobId: upload.id }
        );
      } catch (error) {
        if (incompleteUpload) {
          await store.configstore.set(upload.id, incompleteUpload);
        }
        throw error;
      }

      return {
        status_code: request.method === 'POST' ? 201 : 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ok: true, jobId: upload.id }),
      };
    } catch (error) {
      if (isTusHookError(error)) {
        throw error;
      }
      console.error(
        JSON.stringify({
          event: 'backstage_ingest.finish_failed',
          uploadId: upload.id,
          reason: 'finish_failed',
        })
      );
      throw tusError(500, 'Backstage artifact ingest failed.');
    }
  },
});

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get('authorization');
  const match = authorization ? /^Bearer\s+(.+)$/i.exec(authorization) : null;
  return match?.[1]?.trim() || undefined;
}

async function handleJobRequest(request: Request, jobId: string): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return applyJobCors(
      request,
      new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
        },
      })
    );
  }

  const token = bearerToken(request);
  if (!token) {
    return applyJobCors(request, Response.json({ error: 'Unauthorized' }, { status: 401 }));
  }

  let claims: BackstageUploadClaims | BackstageMaterializePollClaims;
  try {
    const payload = await verify(config.ingestSecret, token, { ignoreExpiry: true });
    claims =
      payload.typ === 'backstage-materialize-poll'
        ? parseMaterializePollClaims(await verify(config.ingestSecret, token))
        : parseUploadClaims(payload);
  } catch {
    return applyJobCors(request, Response.json({ error: 'Unauthorized' }, { status: 401 }));
  }

  const job = await queue.getJob(jobId);
  if (!job) {
    return applyJobCors(request, Response.json({ error: 'Not found' }, { status: 404 }));
  }

  const jobClaims = job.data.claims;
  const commonOwnershipMismatch =
    claims.authUserId !== jobClaims.authUserId || claims.packageId !== jobClaims.packageId;
  let uploadOwnershipMismatch = false;
  let materializeOwnershipMismatch = false;
  if (isUploadJobData(job.data)) {
    uploadOwnershipMismatch =
      claims.typ !== 'backstage-upload' || claims.declaredSha256 !== job.data.claims.declaredSha256;
  } else {
    materializeOwnershipMismatch =
      claims.typ !== 'backstage-materialize-poll' ||
      claims.jobId !== jobId ||
      claims.version !== job.data.claims.version;
  }
  if (commonOwnershipMismatch || uploadOwnershipMismatch || materializeOwnershipMismatch) {
    return applyJobCors(request, Response.json({ error: 'Forbidden' }, { status: 403 }));
  }

  const state = await job.getState();
  if (state === 'completed') {
    // BullMQ does not refresh this Job instance when the worker completes during getState().
    // Reload it so a completed response always carries the persisted signed result.
    const completedJob = await queue.getJob(jobId);
    return applyJobCors(
      request,
      Response.json({ state: 'completed', result: completedJob?.returnvalue })
    );
  }
  if (state === 'failed') {
    const reason =
      isUploadJobData(job.data) && job.failedReason === MANAGED_PATHS_PAYLOAD_TOO_LARGE_REASON
        ? MANAGED_PATHS_PAYLOAD_TOO_LARGE_REASON
        : FAILED_JOB_REASON;
    return applyJobCors(request, Response.json({ state: 'failed', reason }));
  }
  return applyJobCors(request, Response.json({ state: 'processing' }));
}

async function handleMaterializeRequest(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return applyJobCors(
      request,
      new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
        },
      })
    );
  }

  let token: string | undefined;
  try {
    const body = await readMaterializeRequestJson(request);
    token =
      typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body) &&
      typeof (body as { token?: unknown }).token === 'string'
        ? (body as { token: string }).token.trim() || undefined
        : undefined;
  } catch (error) {
    if (error instanceof MaterializeRequestBodyTooLargeError) {
      return applyJobCors(
        request,
        Response.json(
          { error: 'Request body too large', limitBytes: MAX_MATERIALIZE_BODY_BYTES },
          { status: 413 }
        )
      );
    }
    token = undefined;
  }
  if (!token) {
    return applyJobCors(request, Response.json({ error: 'Unauthorized' }, { status: 401 }));
  }

  let claims: BackstageMaterializeClaims;
  try {
    claims = parseMaterializeClaims(await verify(config.ingestSecret, token));
  } catch {
    return applyJobCors(request, Response.json({ error: 'Unauthorized' }, { status: 401 }));
  }

  const expectedRepositoryId = loreRepositoryIdForCreator(
    claims.authUserId,
    config.lore.repoNamespaceSalt
  );
  if (expectedRepositoryId !== claims.repositoryId) {
    return applyJobCors(request, Response.json({ error: 'Forbidden' }, { status: 403 }));
  }

  const jobId = crypto.randomUUID();
  const pollClaims: BackstageMaterializePollClaims = {
    typ: 'backstage-materialize-poll',
    authUserId: claims.authUserId,
    packageId: claims.packageId,
    version: claims.version,
    jobId,
    exp: claims.exp,
  };
  const pollToken = await sign(config.ingestSecret, pollClaims);
  try {
    await queue.add('materialize', { claims }, { jobId });
  } catch {
    console.error(
      JSON.stringify({
        event: 'backstage_ingest.materialize_enqueue_failed',
        materializeJobId: jobId,
        reason: 'materialize_enqueue_failed',
      })
    );
    return applyJobCors(request, Response.json({ error: 'Unavailable' }, { status: 503 }));
  }
  return applyJobCors(request, Response.json({ jobId, pollToken }));
}

const httpServer = Bun.serve({
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true });
    }
    if (config.allowedOrigins.length === 0 && !isSameOriginRequest(request)) {
      return new Response('Cross-origin uploads are not allowed.\n', { status: 403 });
    }

    const jobMatch = /^\/jobs\/([^/]+)$/.exec(url.pathname);
    if (jobMatch && (request.method === 'GET' || request.method === 'OPTIONS')) {
      return await handleJobRequest(request, decodeURIComponent(jobMatch[1]));
    }

    if (
      url.pathname === '/materialize' &&
      (request.method === 'POST' || request.method === 'OPTIONS')
    ) {
      return await handleMaterializeRequest(request);
    }

    const response = await server.handleWeb(request);
    return config.allowedOrigins.length === 0 ? removeCorsWildcard(response) : response;
  },
});

let uploadSweepRunning = false;
async function sweepAbandonedUploads(): Promise<void> {
  if (uploadSweepRunning) {
    return;
  }
  uploadSweepRunning = true;
  try {
    const count = await server.cleanUpExpiredUploads();
    if (count > 0) {
      console.info(
        JSON.stringify({
          event: 'backstage_ingest.abandoned_upload_swept',
          count,
        })
      );
    }
  } catch {
    console.error(
      JSON.stringify({
        event: 'backstage_ingest.abandoned_upload_sweep_failed',
        reason: 'abandoned_upload_sweep_failed',
      })
    );
  } finally {
    uploadSweepRunning = false;
  }
}

const uploadSweepInterval = setInterval(
  () => void sweepAbandonedUploads(),
  Math.min(DEFAULT_UPLOAD_SWEEP_INTERVAL_MS, config.uploadTtlMs)
);
uploadSweepInterval.unref();

let shuttingDown = false;
process.once('SIGTERM', () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearInterval(uploadSweepInterval);
  void (async () => {
    await worker.close();
    await queue.close();
    await connection.quit();
    await httpServer.stop(false);
  })();
});

console.info(
  JSON.stringify({
    event: 'backstage_ingest.started',
    port: config.port,
    tusDirectory: config.tusDirectory,
    concurrency: config.concurrency,
  })
);
