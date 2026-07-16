import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import { FileStore } from '@tus/file-store';
import { Server, type Upload } from '@tus/server';
import type { Catalog } from '../catalog';
import { assembleVersion, beginVersion } from '../ingest-pipeline';

export const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
export const INGEST_TUS_PATH = '/files';

const VERSION_ID_METADATA_KEY = '_catalogVersionId';
const ALLOWED_EXTENSIONS = new Set(['.spp', '.unitypackage', '.zip']);
const GENERIC_BINARY_TYPES = new Set(['application/octet-stream']);
const CONTENT_TYPES_BY_EXTENSION = new Map<string, ReadonlySet<string>>([
  [
    '.unitypackage',
    new Set([
      'application/gzip',
      'application/vnd.unity',
      'application/x-gzip',
      'application/x-unitypackage',
    ]),
  ],
  ['.zip', new Set(['application/zip', 'application/x-zip-compressed'])],
  ['.spp', new Set(['application/vnd.substance-painter', 'application/x-substance-painter'])],
]);

type TusHookError = {
  status_code: number;
  body: string;
};

export interface CreateIngestTusServerInput {
  catalog: Catalog;
  storePath: string;
  indexDir: string;
  uploadDir: string;
  maxBytes?: number;
}

function tusError(status_code: number, body: string): TusHookError {
  return { status_code, body: `${body}\n` };
}

function requiredMetadata(metadata: Upload['metadata'], key: string, label = key): string {
  const value = metadata?.[key]?.trim();
  if (!value) {
    throw tusError(400, `Upload metadata must include ${label}.`);
  }
  return value;
}

function normalizedContentType(metadata: Upload['metadata']): string | undefined {
  const value = metadata?.filetype ?? metadata?.type;
  return value?.split(';', 1)[0]?.trim().toLowerCase() || undefined;
}

function validateArtifactMetadata(upload: Upload): {
  extension: string;
  filename: string;
  packageId: string;
  version: string;
} {
  const filename = requiredMetadata(upload.metadata, 'filename');
  const packageId = requiredMetadata(upload.metadata, 'packageId');
  const version = requiredMetadata(upload.metadata, 'version');
  const extension = extname(filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw tusError(415, 'Upload filename must end in .unitypackage, .zip, or .spp.');
  }

  const contentType = normalizedContentType(upload.metadata);
  const extensionContentTypes = CONTENT_TYPES_BY_EXTENSION.get(extension);
  if (
    contentType &&
    !GENERIC_BINARY_TYPES.has(contentType) &&
    !extensionContentTypes?.has(contentType)
  ) {
    throw tusError(415, `Upload metadata type is not allowed for ${extension}.`);
  }

  return { extension, filename, packageId, version };
}

function uploadExtension(metadata: Record<string, string | null> | undefined): string {
  const extension = extname(metadata?.filename?.trim() ?? '').toLowerCase();
  return ALLOWED_EXTENSIONS.has(extension) ? extension : '';
}

function versionIdForUpload(upload: Upload): string {
  return requiredMetadata(upload.metadata, VERSION_ID_METADATA_KEY, 'catalog version mapping');
}

function sendHealth(response: ServerResponse): void {
  const body = JSON.stringify({ ok: true });
  response.writeHead(200, {
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function isHealthRequest(request: IncomingMessage): boolean {
  if (request.method !== 'GET') {
    return false;
  }
  return new URL(request.url ?? '/', 'http://localhost').pathname === '/healthz';
}

function handleUnexpectedServerError(
  response: ServerResponse,
  error: unknown,
  startedAt: number
): void {
  console.error(
    JSON.stringify({
      event: 'ingest_tus.request_failed',
      reason: error instanceof Error ? error.name : 'unknown_error',
      durationMs: Math.round(performance.now() - startedAt),
    })
  );
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Internal server error\n');
}

/**
 * Implements tus 1.0 with the maintained Node server and file store.
 * Protocol and hook behavior: https://tus.io/protocols/resumable-upload and
 * https://github.com/tus/tus-node-server/tree/main/packages/server
 */
export function createIngestTusServer(input: CreateIngestTusServerInput): RequestListener {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('maxBytes must be a positive safe integer');
  }

  const uploadDir = resolve(input.uploadDir);
  mkdirSync(uploadDir, { recursive: true });
  const fileStore = new FileStore({ directory: uploadDir });
  const tusServer = new Server({
    path: INGEST_TUS_PATH,
    datastore: fileStore,
    maxSize: maxBytes,
    namingFunction(_request, metadata) {
      return `${randomBytes(16).toString('hex')}${uploadExtension(metadata)}`;
    },
    async onUploadCreate(_request, upload) {
      if (upload.size === undefined) {
        throw tusError(400, 'Upload-Length is required.');
      }
      if (upload.size > maxBytes) {
        throw tusError(413, 'Upload exceeds the configured size limit.');
      }

      const metadata = validateArtifactMetadata(upload);
      const uploading = await beginVersion({
        catalog: input.catalog,
        packageId: metadata.packageId,
        version: metadata.version,
      });
      console.info(
        JSON.stringify({
          event: 'ingest_tus.upload_created',
          uploadId: upload.id,
          versionId: uploading.id,
          state: uploading.state,
        })
      );
      return {
        metadata: {
          ...upload.metadata,
          filename: metadata.filename,
          packageId: metadata.packageId,
          version: metadata.version,
          [VERSION_ID_METADATA_KEY]: uploading.id,
        },
      };
    },
    async onUploadFinish(_request, upload) {
      const startedAt = performance.now();
      const storedUpload = upload.storage?.path ? upload : await fileStore.getUpload(upload.id);
      const versionId = versionIdForUpload(storedUpload);
      if (storedUpload.storage?.type !== 'file' || !storedUpload.storage.path) {
        await input.catalog.markFailed(versionId, 'Tus upload is missing its file storage path');
        throw tusError(500, 'Completed upload is missing its file storage path.');
      }

      try {
        const assembled = await assembleVersion({
          catalog: input.catalog,
          storePath: input.storePath,
          indexDir: input.indexDir,
          versionId,
          inputPath: storedUpload.storage.path,
        });
        console.info(
          JSON.stringify({
            event: 'ingest_tus.upload_assembled',
            uploadId: upload.id,
            versionId,
            state: assembled.state,
            durationMs: Math.round(performance.now() - startedAt),
          })
        );
        return {};
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'ingest_tus.assembly_failed',
            uploadId: upload.id,
            versionId,
            reason: error instanceof Error ? error.name : 'unknown_error',
            durationMs: Math.round(performance.now() - startedAt),
          })
        );
        throw tusError(500, 'Artifact assembly failed.');
      }
    },
  });

  return (request, response) => {
    const startedAt = performance.now();
    if (isHealthRequest(request)) {
      sendHealth(response);
      return;
    }
    void tusServer
      .handle(request, response)
      .catch((error) => handleUnexpectedServerError(response, error, startedAt));
  };
}
