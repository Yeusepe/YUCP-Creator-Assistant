import { FileStore } from '@tus/file-store';
import { Server } from '@tus/server';
import {
  type BackstageIngestResult,
  type BackstageUploadClaims,
  parseUploadClaims,
  sign,
  validateSigningSecret,
  verify,
} from '@yucp/shared/backstageIngest';
import { MAX_BACKSTAGE_PACKAGE_BYTES } from '@yucp/shared/backstageLimits';
import { materializeBackstageReleaseArtifact } from '@yucp/shared/backstageReleaseMaterialization';
import {
  type ConfiguredLoreBackstageConfig,
  loreRepositoryIdForCreator,
  putBackstageBytesToLore,
  requireLoreBackstageConfig,
} from '@yucp/shared/loreBackstageClient';
import type { LoreBackstageArtifactReference } from '@yucp/shared/loreBackstageDelivery';
import { Queue, Worker } from 'bullmq';
import { Redis as IORedis } from 'ioredis';

const DEFAULT_PORT = 8080;
const DEFAULT_TUS_DIRECTORY = '/data/tus';
const DEFAULT_LORE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_UPLOAD_BYTES = MAX_BACKSTAGE_PACKAGE_BYTES;
const RESULT_TTL_SECONDS = 15 * 60;
const QUEUE_NAME = 'backstage-ingest';
const FAILED_JOB_REASON = 'ingest_failed';

type ServiceConfig = {
  allowedOrigins: string[];
  port: number;
  tusDirectory: string;
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
    ingestSecret,
    redisUrl: requiredEnv('REDIS_URL'),
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

const config = loadConfig();
const store = new FileStore({ directory: config.tusDirectory });
// ponytail: ioredis is BullMQ's default and stable on Bun; Bun's native Redis client dropped connections on 1.3.9.
const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue<BackstageIngestJobData, string>(QUEUE_NAME, {
  connection,
  prefix: config.queuePrefix,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 3_600 },
    removeOnFail: { age: 86_400 },
  },
});

const worker = new Worker<BackstageIngestJobData, string>(
  QUEUE_NAME,
  async (job) => {
    const startedAt = performance.now();
    const { claims, stagedPath, uploadId } = job.data;
    let bytes: ArrayBuffer;
    let materialized: Awaited<ReturnType<typeof materializeBackstageReleaseArtifact>>;
    try {
      // ponytail: per-job peak is about 2x package size for source plus deliverable; concurrency and RAM provisioning govern it until streaming materialization is available.
      bytes = await Bun.file(stagedPath).arrayBuffer();
      materialized = await materializeBackstageReleaseArtifact({
        sourceBytes: new Uint8Array(bytes),
        deliveryName: claims.deliveryName,
        contentType: claims.sourceContentType,
        packageId: claims.packageId,
        version: claims.version,
        displayName: claims.materializeMetadata?.displayName,
        metadata: claims.materializeMetadata?.metadata,
      });
    } catch {
      console.error(
        JSON.stringify({
          event: 'backstage_ingest.materialization_failed',
          uploadId,
          reason: 'materialization_failed',
          durationMs: Math.round(performance.now() - startedAt),
        })
      );
      throw new Error('materialization_failed');
    }

    const repositoryId = claims.repositoryId;
    let rawStored: Awaited<ReturnType<typeof putBackstageBytesToLore>>;
    try {
      rawStored = await putBackstageBytesToLore({
        config: config.lore,
        repositoryId,
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

    let deliverableStored: Awaited<ReturnType<typeof putBackstageBytesToLore>>;
    try {
      deliverableStored = await putBackstageBytesToLore({
        config: config.lore,
        repositoryId,
        bytes: materialized.bytes,
      });
    } catch {
      console.error(
        JSON.stringify({
          event: 'backstage_ingest.lore_delivery_failed',
          uploadId,
          reason: 'lore_deliverable_put_failed',
          rawByteSize: rawStored.byteSize,
          deliverableByteSize: materialized.bytes.byteLength,
          durationMs: Math.round(performance.now() - startedAt),
        })
      );
      throw new Error('lore_deliverable_put_failed');
    }

    const uploadedAt = new Date().toISOString();
    const loreSource = buildLoreReference({
      repositoryId,
      stored: rawStored,
      authUserId: claims.authUserId,
      uploadedAt,
    });
    const loreDelivery = buildLoreReference({
      repositoryId,
      stored: deliverableStored,
      authUserId: claims.authUserId,
      uploadedAt,
    });
    const result: BackstageIngestResult = {
      typ: 'backstage-ingest-result',
      authUserId: claims.authUserId,
      packageId: claims.packageId,
      version: claims.version,
      loreSource,
      loreDelivery,
      rawSha256: rawStored.sha256,
      rawByteSize: rawStored.byteSize,
      rawDeliveryName: claims.deliveryName,
      rawContentType: claims.sourceContentType,
      deliverableSha256: deliverableStored.sha256,
      deliverableByteSize: deliverableStored.byteSize,
      deliverableDeliveryName: materialized.deliveryName,
      deliverableContentType: materialized.contentType,
      exp: Math.floor(Date.now() / 1000) + RESULT_TTL_SECONDS,
    };
    const signedResult = await sign(config.ingestSecret, result);

    console.info(
      JSON.stringify({
        event: 'backstage_ingest.completed',
        uploadId,
        rawByteSize: rawStored.byteSize,
        deliverableByteSize: deliverableStored.byteSize,
        durationMs: Math.round(performance.now() - startedAt),
      })
    );

    return signedResult;
  },
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

worker.on('completed', (job) => {
  void removeStagedUpload(job.id);
});

worker.on('failed', (job) => {
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
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

      await queue.add(
        'materialize',
        { uploadId: upload.id, stagedPath, claims },
        { jobId: upload.id }
      );

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

  let claims: BackstageUploadClaims;
  try {
    claims = parseUploadClaims(await verify(config.ingestSecret, token, { ignoreExpiry: true }));
  } catch {
    return applyJobCors(request, Response.json({ error: 'Unauthorized' }, { status: 401 }));
  }

  const job = await queue.getJob(jobId);
  if (!job) {
    return applyJobCors(request, Response.json({ error: 'Not found' }, { status: 404 }));
  }

  const jobClaims = job.data.claims;
  if (
    claims.authUserId !== jobClaims.authUserId ||
    claims.packageId !== jobClaims.packageId ||
    claims.declaredSha256 !== jobClaims.declaredSha256
  ) {
    return applyJobCors(request, Response.json({ error: 'Forbidden' }, { status: 403 }));
  }

  const state = await job.getState();
  if (state === 'completed') {
    return applyJobCors(request, Response.json({ state: 'completed', result: job.returnvalue }));
  }
  if (state === 'failed') {
    return applyJobCors(request, Response.json({ state: 'failed', reason: FAILED_JOB_REASON }));
  }
  return applyJobCors(request, Response.json({ state: 'processing' }));
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

    const response = await server.handleWeb(request);
    return config.allowedOrigins.length === 0 ? removeCorsWildcard(response) : response;
  },
});

let shuttingDown = false;
process.once('SIGTERM', () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
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
