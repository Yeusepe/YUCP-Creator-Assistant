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
import { materializeBackstageReleaseArtifact } from '@yucp/shared/backstageReleaseMaterialization';
import {
  type ConfiguredLoreBackstageConfig,
  loreRepositoryIdForCreator,
  putBackstageBytesToLore,
  requireLoreBackstageConfig,
  sha256ArrayBuffer,
} from '@yucp/shared/loreBackstageClient';
import type { LoreBackstageArtifactReference } from '@yucp/shared/loreBackstageDelivery';

const DEFAULT_PORT = 8080;
const DEFAULT_TUS_DIRECTORY = '/data/tus';
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const RESULT_TTL_SECONDS = 15 * 60;
const RESULT_HEADER = 'X-Backstage-Ingest-Result';

type ServiceConfig = {
  allowedOrigins: string[];
  port: number;
  tusDirectory: string;
  ingestSecret: string;
  lore: ConfiguredLoreBackstageConfig;
};

type TusHookError = {
  status_code: number;
  body: string;
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
    lore: requireLoreBackstageConfig({
      apiBaseUrl: requiredEnv('LORE_API_BASE_URL'),
      repoNamespaceSalt: requiredEnv('LORE_REPO_NAMESPACE_SALT'),
      accessClientId: requiredEnv('LORE_ACCESS_CLIENT_ID'),
      accessClientSecret: requiredEnv('LORE_ACCESS_CLIENT_SECRET'),
      timeoutMs: optionalPositiveInteger('LORE_TIMEOUT_MS'),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
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

const config = loadConfig();
const store = new FileStore({ directory: config.tusDirectory });

const server = new Server({
  path: '/files',
  datastore: store,
  maxSize: MAX_UPLOAD_BYTES,
  respectForwardedHeaders: true,
  allowedOrigins: config.allowedOrigins,
  exposedHeaders: [RESULT_HEADER],
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
    const startedAt = performance.now();
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

    try {
      const storedUpload = upload.storage?.path ? upload : await store.getUpload(upload.id);
      const stagedPath = storedUpload.storage?.path;
      if (storedUpload.storage?.type !== 'file' || !stagedPath) {
        throw tusError(500, 'Staged upload does not have file storage metadata.');
      }

      const stagedFile = Bun.file(stagedPath);
      if (stagedFile.size !== claims.byteSize) {
        throw tusError(422, 'Uploaded byte size does not match the upload token.');
      }
      const bytes = await stagedFile.arrayBuffer();
      const rawSha256 = await sha256ArrayBuffer(bytes);
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

      let rawStored: Awaited<ReturnType<typeof putBackstageBytesToLore>>;
      try {
        rawStored = await putBackstageBytesToLore({
          config: config.lore,
          repositoryId,
          bytes,
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'backstage_ingest.lore_source_failed',
            uploadId: upload.id,
            repositoryId,
            error: errorMessage(error),
          })
        );
        throw tusError(502, 'Lore rejected the source artifact.');
      }

      let materialized: Awaited<ReturnType<typeof materializeBackstageReleaseArtifact>>;
      try {
        materialized = await materializeBackstageReleaseArtifact({
          sourceBytes: new Uint8Array(bytes),
          deliveryName: claims.deliveryName,
          contentType: claims.sourceContentType,
          packageId: claims.packageId,
          version: claims.version,
          displayName: claims.materializeMetadata?.displayName,
          metadata: claims.materializeMetadata?.metadata,
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'backstage_ingest.materialization_failed',
            uploadId: upload.id,
            repositoryId,
            error: errorMessage(error),
          })
        );
        throw tusError(422, 'The source artifact could not be materialized.');
      }

      let deliverableStored: Awaited<ReturnType<typeof putBackstageBytesToLore>>;
      try {
        deliverableStored = await putBackstageBytesToLore({
          config: config.lore,
          repositoryId,
          bytes: materialized.bytes,
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'backstage_ingest.lore_delivery_failed',
            uploadId: upload.id,
            repositoryId,
            error: errorMessage(error),
          })
        );
        throw tusError(502, 'Lore rejected the deliverable artifact.');
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

      try {
        await store.remove(upload.id);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'backstage_ingest.cleanup_failed',
            uploadId: upload.id,
            error: errorMessage(error),
          })
        );
      }

      console.info(
        JSON.stringify({
          event: 'backstage_ingest.completed',
          uploadId: upload.id,
          repositoryId,
          rawByteSize: rawStored.byteSize,
          deliverableByteSize: deliverableStored.byteSize,
          durationMs: Math.round(performance.now() - startedAt),
          traceparent: request.headers.get('traceparent') ?? undefined,
        })
      );

      return {
        status_code: request.method === 'POST' ? 201 : 200,
        headers: {
          'Content-Type': 'application/json',
          [RESULT_HEADER]: signedResult,
        },
        body: JSON.stringify({ ok: true }),
      };
    } catch (error) {
      if (isTusHookError(error)) {
        throw error;
      }
      console.error(
        JSON.stringify({
          event: 'backstage_ingest.finish_failed',
          uploadId: upload.id,
          error: errorMessage(error),
        })
      );
      throw tusError(500, 'Backstage artifact ingest failed.');
    }
  },
});

Bun.serve({
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true });
    }
    if (config.allowedOrigins.length === 0 && !isSameOriginRequest(request)) {
      return new Response('Cross-origin uploads are not allowed.\n', { status: 403 });
    }
    const response = await server.handleWeb(request);
    return config.allowedOrigins.length === 0 ? removeCorsWildcard(response) : response;
  },
});

console.info(
  JSON.stringify({
    event: 'backstage_ingest.started',
    port: config.port,
    tusDirectory: config.tusDirectory,
  })
);
