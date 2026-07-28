import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import { FileStore } from '@tus/file-store';
import { Server, type Upload } from '@tus/server';
import { type Catalog, CatalogInvariantError, withCatalogHeartbeat } from '../catalog';
import type { StorageGcCatalog } from '../catalog/storageGcCatalog';
import { assembleVersion, beginVersion } from '../ingest-pipeline';
import type { CasStore } from '../storage-core/desyncCas';
import { isProtectionPolicyId, type ProtectionPolicyId } from '../storage-core/protectionPolicyId';
import { UPLOAD_CAPABILITY_HEADERS, verifyUploadCapability } from '../storage-core/uploadSigning';
import { createCatalogControlHandler, isCatalogControlRequest } from './catalogControl';
import { persistCompletedUpload, type QuarantineStoragePort } from './quarantine';

export const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
export const INGEST_TUS_PATH = '/files';
export { UPLOAD_CAPABILITY_HEADERS };

const CORS_ALLOW_METHODS = 'POST,PATCH,HEAD,OPTIONS,GET';
const CORS_ALLOW_HEADERS = [
  'Content-Type',
  'Tus-Resumable',
  'Upload-Length',
  'Upload-Offset',
  'Upload-Metadata',
  'Upload-Defer-Length',
  'Upload-Concat',
  'Upload-Checksum',
  ...Object.values(UPLOAD_CAPABILITY_HEADERS),
].join(',');
const CORS_EXPOSE_HEADERS = 'Location,Upload-Offset,Upload-Length';

const VERSION_ID_METADATA_KEY = '_catalogVersionId';
const CREATOR_ID_METADATA_KEY = '_creatorId';
const PROTECTION_POLICY_METADATA_KEY = '_protectionPolicyId';
const ALLOWED_EXTENSIONS = new Set(['.spp', '.unitypackage', '.zip']);
const UPLOAD_ID_PATTERN = /^[0-9a-f]{32}(?:\.(?:spp|unitypackage|zip))?$/;
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
  allowedOrigin?: string;
  catalog: Catalog;
  commonStore: CasStore;
  metadataStore: CasStore;
  protectedStore: CasStore;
  quarantineStorage: QuarantineStoragePort;
  scratchRoot: string;
  uploadDir: string;
  maxBytes?: number;
  uploadHmacKey: string;
  catalogControlSharedSecret: string;
  releasePins?: Pick<StorageGcCatalog, 'createReleasePin' | 'releaseReleasePin'>;
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

function requiredProtectionPolicyId(metadata: Upload['metadata']): ProtectionPolicyId {
  const value = requiredMetadata(metadata, PROTECTION_POLICY_METADATA_KEY, 'protection policy');
  if (!isProtectionPolicyId(value)) {
    throw tusError(403, 'Upload protection policy is not supported.');
  }
  return value;
}

function normalizedContentType(metadata: Upload['metadata']): string | undefined {
  const value = metadata?.filetype ?? metadata?.type;
  return value?.split(';', 1)[0]?.trim().toLowerCase() || undefined;
}

function quarantineContentType(upload: Upload): string {
  const declared = normalizedContentType(upload.metadata);
  if (declared && !GENERIC_BINARY_TYPES.has(declared)) {
    return declared;
  }
  switch (uploadExtension(upload.metadata)) {
    case '.zip':
      return 'application/zip';
    case '.unitypackage':
      return 'application/x-unitypackage';
    case '.spp':
      return 'application/vnd.substance-painter';
    default:
      throw tusError(415, 'Completed upload type is not supported.');
  }
}

function validateArtifactMetadata(upload: Upload): {
  catalogProductId?: string;
  extension: string;
  filename: string;
  packageId: string;
  version: string;
} {
  const filename = requiredMetadata(upload.metadata, 'filename');
  const packageId = requiredMetadata(upload.metadata, 'packageId');
  const version = requiredMetadata(upload.metadata, 'version');
  const catalogProductId = upload.metadata?.catalogProductId?.trim() || undefined;
  if ([...packageId].length > 256) {
    throw tusError(400, 'Upload metadata packageId must not exceed 256 characters.');
  }
  if ([...version].length > 256) {
    throw tusError(400, 'Upload metadata version must not exceed 256 characters.');
  }
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

  return {
    extension,
    filename,
    packageId,
    version,
    ...(catalogProductId ? { catalogProductId } : {}),
  };
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

function singleRequestHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value !== 'string' || !value.trim() || value.includes(',')) {
    return undefined;
  }
  return value.trim();
}

function normalizeAllowedOrigin(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const url = new URL(normalized);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin === 'null') {
    throw new Error('allowedOrigin must be an absolute HTTP(S) origin');
  }
  return url.origin;
}

function isTusPath(request: IncomingMessage): boolean {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  return pathname === INGEST_TUS_PATH || pathname.startsWith(`${INGEST_TUS_PATH}/`);
}

function setCorsHeaders(response: ServerResponse, origin: string): void {
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
  response.setHeader('Vary', 'Origin');
}

function handleCorsPreflight(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigin: string | undefined
): boolean {
  if (
    request.method !== 'OPTIONS' ||
    !isTusPath(request) ||
    !singleRequestHeader(request, 'access-control-request-method')
  ) {
    return false;
  }

  const origin = singleRequestHeader(request, 'origin');
  if (!allowedOrigin || origin !== allowedOrigin) {
    response.writeHead(403, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      Vary: 'Origin',
    });
    response.end('Origin not allowed\n');
    return true;
  }

  setCorsHeaders(response, origin);
  response.setHeader('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
  response.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
  response.writeHead(204);
  response.end();
  return true;
}

async function authorizeUploadRequest(
  request: IncomingMessage,
  hmacKey: string
): Promise<
  | { status: 401 | 403 }
  | {
      catalogProductId?: string;
      creatorId: string;
      editionId: string;
      packageId: string;
      protectionPolicyId: ProtectionPolicyId;
      version: string;
      versionId: string;
    }
> {
  const exp = singleRequestHeader(request, UPLOAD_CAPABILITY_HEADERS.exp);
  const sig = singleRequestHeader(request, UPLOAD_CAPABILITY_HEADERS.sig);
  const versionId = singleRequestHeader(request, UPLOAD_CAPABILITY_HEADERS.versionId);
  const encodedPackageId = singleRequestHeader(request, UPLOAD_CAPABILITY_HEADERS.packageId);
  const encodedCreatorId = singleRequestHeader(request, UPLOAD_CAPABILITY_HEADERS.creatorId);
  const editionId = singleRequestHeader(request, UPLOAD_CAPABILITY_HEADERS.editionId);
  const protectionPolicyId = singleRequestHeader(
    request,
    UPLOAD_CAPABILITY_HEADERS.protectionPolicyId
  );
  const encodedVersion = singleRequestHeader(request, UPLOAD_CAPABILITY_HEADERS.version);
  if (
    !exp ||
    !sig ||
    !versionId ||
    !encodedCreatorId ||
    !editionId ||
    !encodedPackageId ||
    !encodedVersion ||
    !protectionPolicyId
  ) {
    return { status: 401 };
  }
  let catalogProductId: string | undefined;
  let creatorId: string;
  let packageId: string;
  let version: string;
  try {
    const encodedCatalogProductId = singleRequestHeader(
      request,
      UPLOAD_CAPABILITY_HEADERS.catalogProductId
    );
    catalogProductId = encodedCatalogProductId
      ? decodeURIComponent(encodedCatalogProductId)
      : undefined;
    creatorId = decodeURIComponent(encodedCreatorId);
    packageId = decodeURIComponent(encodedPackageId);
    version = decodeURIComponent(encodedVersion);
  } catch {
    return { status: 403 };
  }
  if (
    !(await verifyUploadCapability(
      {
        catalogProductId,
        creatorId,
        editionId,
        exp,
        packageId,
        protectionPolicyId,
        sig,
        version,
        versionId,
      },
      hmacKey
    ))
  ) {
    return { status: 403 };
  }
  if (!isProtectionPolicyId(protectionPolicyId)) {
    return { status: 403 };
  }
  return {
    catalogProductId,
    creatorId,
    editionId,
    packageId,
    protectionPolicyId,
    version,
    versionId,
  };
}

function requestUploadId(request: IncomingMessage): string | undefined {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  const prefix = `${INGEST_TUS_PATH}/`;
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const encodedId = pathname.slice(prefix.length);
  if (!encodedId) {
    return undefined;
  }
  try {
    const decodedId = decodeURIComponent(encodedId);
    return UPLOAD_ID_PATTERN.test(decodedId) ? decodedId : undefined;
  } catch {
    return undefined;
  }
}

function isUploadResourceRequest(request: IncomingMessage): boolean {
  return new URL(request.url ?? '/', 'http://localhost').pathname.startsWith(`${INGEST_TUS_PATH}/`);
}

async function removeUploadBestEffort(
  fileStore: FileStore,
  uploadId: string,
  versionId: string
): Promise<void> {
  try {
    await fileStore.remove(uploadId);
  } catch (cleanupError) {
    console.error(
      JSON.stringify({
        event: 'ingest_tus.upload_cleanup_failed',
        uploadId,
        versionId,
        ...loggedErrorDetail(cleanupError),
      })
    );
  }
}

function sendCapabilityError(response: ServerResponse, status: 401 | 403): void {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    ...(status === 401 ? { 'WWW-Authenticate': 'YucpUploadCapability' } : {}),
  });
  response.end(status === 401 ? 'Upload capability required\n' : 'Invalid upload capability\n');
}

function loggedErrorDetail(error: unknown): { reason: string; errorMessage: string } {
  return error instanceof Error
    ? { reason: error.name, errorMessage: error.message.slice(0, 500) }
    : { reason: 'unknown_error', errorMessage: String(error).slice(0, 500) };
}

function handleUnexpectedServerError(
  response: ServerResponse,
  error: unknown,
  startedAt: number
): void {
  console.error(
    JSON.stringify({
      event: 'ingest_tus.request_failed',
      ...loggedErrorDetail(error),
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

export async function handleTusPatchWithOwnershipSignal(input: {
  handle: () => Promise<void>;
  request: { destroy(): void };
  signal: AbortSignal;
}): Promise<void> {
  const abortRequest = (): void => input.request.destroy();
  input.signal.addEventListener('abort', abortRequest, { once: true });
  try {
    if (input.signal.aborted) {
      abortRequest();
    }
    input.signal.throwIfAborted();
    await input.handle();
  } finally {
    input.signal.removeEventListener('abort', abortRequest);
  }
}

/**
 * Implements tus 1.0 with the maintained Node server and file store.
 * Protocol and hook behavior: https://tus.io/protocols/resumable-upload and
 * https://github.com/tus/tus-node-server/tree/main/packages/server
 */
export function createIngestTusServer(input: CreateIngestTusServerInput): RequestListener {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const allowedOrigin = normalizeAllowedOrigin(input.allowedOrigin);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('maxBytes must be a positive safe integer');
  }
  if (!input.uploadHmacKey.trim()) {
    throw new Error('uploadHmacKey must not be empty');
  }
  const uploadDir = resolve(input.uploadDir);
  mkdirSync(uploadDir, { recursive: true });
  const fileStore = new FileStore({ directory: uploadDir });
  const heartbeatSignals = new AsyncLocalStorage<AbortSignal>();
  const catalogControlHandler = createCatalogControlHandler({
    catalog: input.catalog,
    ...(input.releasePins ? { releasePins: input.releasePins } : {}),
    sharedSecret: input.catalogControlSharedSecret,
  });
  const tusServer = new Server({
    path: INGEST_TUS_PATH,
    datastore: fileStore,
    relativeLocation: true,
    getFileIdFromRequest(_request, lastPath) {
      return lastPath && UPLOAD_ID_PATTERN.test(lastPath) ? lastPath : undefined;
    },
    maxSize: maxBytes,
    allowedCredentials: Boolean(allowedOrigin),
    allowedHeaders: Object.values(UPLOAD_CAPABILITY_HEADERS),
    allowedOrigins: allowedOrigin ? [allowedOrigin] : undefined,
    exposedHeaders: ['Location', 'Upload-Offset', 'Upload-Length'],
    namingFunction(request, metadata) {
      const versionId = request.headers.get(UPLOAD_CAPABILITY_HEADERS.versionId)?.trim();
      if (
        !versionId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          versionId
        )
      ) {
        return `${randomBytes(16).toString('hex')}${uploadExtension(metadata)}`;
      }
      return `${versionId.replaceAll('-', '').toLowerCase()}${uploadExtension(metadata)}`;
    },
    async onUploadCreate(request, upload) {
      if (upload.size === undefined) {
        throw tusError(400, 'Upload-Length is required.');
      }
      if (upload.size > maxBytes) {
        throw tusError(413, 'Upload exceeds the configured size limit.');
      }

      const metadata = validateArtifactMetadata(upload);
      const versionId = request.headers.get(UPLOAD_CAPABILITY_HEADERS.versionId)?.trim();
      const encodedPackageId = request.headers.get(UPLOAD_CAPABILITY_HEADERS.packageId)?.trim();
      const encodedCreatorId = request.headers.get(UPLOAD_CAPABILITY_HEADERS.creatorId)?.trim();
      const editionId = request.headers.get(UPLOAD_CAPABILITY_HEADERS.editionId)?.trim();
      const protectionPolicyId = request.headers
        .get(UPLOAD_CAPABILITY_HEADERS.protectionPolicyId)
        ?.trim();
      const encodedVersion = request.headers.get(UPLOAD_CAPABILITY_HEADERS.version)?.trim();
      let signedCatalogProductId: string | undefined;
      let signedCreatorId: string;
      let signedPackageId: string;
      let signedVersion: string;
      try {
        const encodedCatalogProductId = request.headers
          .get(UPLOAD_CAPABILITY_HEADERS.catalogProductId)
          ?.trim();
        signedCatalogProductId = encodedCatalogProductId
          ? decodeURIComponent(encodedCatalogProductId)
          : undefined;
        signedCreatorId = decodeURIComponent(encodedCreatorId ?? '');
        signedPackageId = decodeURIComponent(encodedPackageId ?? '');
        signedVersion = decodeURIComponent(encodedVersion ?? '');
      } catch {
        throw tusError(403, 'Upload capability catalog target is invalid.');
      }
      if (
        !versionId ||
        !signedCreatorId ||
        !editionId ||
        !protectionPolicyId ||
        !isProtectionPolicyId(protectionPolicyId) ||
        metadata.packageId !== signedPackageId ||
        metadata.version !== signedVersion ||
        metadata.catalogProductId !== signedCatalogProductId
      ) {
        throw tusError(403, 'Upload metadata does not match the signed capability.');
      }
      let uploading: Awaited<ReturnType<typeof beginVersion>>;
      try {
        uploading = await beginVersion({
          catalog: input.catalog,
          catalogProductId: metadata.catalogProductId,
          editionId,
          packageId: metadata.packageId,
          version: metadata.version,
          versionId,
        });
      } catch (error) {
        if (
          error instanceof CatalogInvariantError ||
          (error instanceof Error && error.message.includes('immutable after upload completion'))
        ) {
          throw tusError(409, 'This package version already exists. Use a new version number.');
        }
        throw error;
      }
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
          ...(metadata.catalogProductId ? { catalogProductId: metadata.catalogProductId } : {}),
          filename: metadata.filename,
          [CREATOR_ID_METADATA_KEY]: signedCreatorId,
          packageId: metadata.packageId,
          version: metadata.version,
          [PROTECTION_POLICY_METADATA_KEY]: protectionPolicyId,
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
        await fileStore.remove(upload.id);
        throw tusError(500, 'Completed upload is missing its file storage path.');
      }

      try {
        await persistCompletedUpload({
          catalog: input.catalog,
          contentType: quarantineContentType(storedUpload),
          path: storedUpload.storage.path,
          storage: input.quarantineStorage,
          versionId,
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'ingest_tus.quarantine_failed',
            uploadId: upload.id,
            versionId,
            ...loggedErrorDetail(error),
            durationMs: Math.round(performance.now() - startedAt),
          })
        );
        throw tusError(503, 'Upload quarantine is temporarily unavailable.');
      }

      const assemblyInput = {
        catalog: input.catalog,
        commonStore: input.commonStore,
        creatorId: requiredMetadata(
          storedUpload.metadata,
          CREATOR_ID_METADATA_KEY,
          'creator identity'
        ),
        metadataStore: input.metadataStore,
        protectedStore: input.protectedStore,
        protectionPolicyId: requiredProtectionPolicyId(storedUpload.metadata),
        scratchRoot: input.scratchRoot,
        versionId,
        inputPath: storedUpload.storage.path,
      };
      void withCatalogHeartbeat({
        catalog: input.catalog,
        state: 'UPLOADING',
        versionId,
        onHeartbeatError(error) {
          console.error(
            JSON.stringify({
              event: 'ingest_tus.assembly_heartbeat_failed',
              uploadId: upload.id,
              versionId,
              ...loggedErrorDetail(error),
            })
          );
        },
        operation: (signal) => assembleVersion(assemblyInput, signal),
      })
        .then((assembled) => {
          console.info(
            JSON.stringify({
              event: 'ingest_tus.upload_assembled',
              uploadId: upload.id,
              versionId,
              state: assembled.state,
              durationMs: Math.round(performance.now() - startedAt),
            })
          );
        })
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              event: 'ingest_tus.assembly_failed',
              uploadId: upload.id,
              versionId,
              ...loggedErrorDetail(error),
              durationMs: Math.round(performance.now() - startedAt),
            })
          );
        })
        .finally(() => removeUploadBestEffort(fileStore, upload.id, versionId));
      console.info(
        JSON.stringify({
          event: 'ingest_tus.assembly_started',
          uploadId: upload.id,
          versionId,
          durationMs: Math.round(performance.now() - startedAt),
        })
      );
      return {};
    },
  });

  return (request, response) => {
    const startedAt = performance.now();
    if (isCatalogControlRequest(request)) {
      catalogControlHandler(request, response);
      return;
    }
    if (isHealthRequest(request)) {
      sendHealth(response);
      return;
    }
    if (handleCorsPreflight(request, response, allowedOrigin)) {
      return;
    }
    const origin = singleRequestHeader(request, 'origin');
    if (allowedOrigin && origin === allowedOrigin) {
      setCorsHeaders(response, origin);
    }
    void (async () => {
      const authorization = await authorizeUploadRequest(request, input.uploadHmacKey);
      if ('status' in authorization) {
        console.warn(
          JSON.stringify({
            event: 'ingest_tus.capability_rejected',
            status: authorization.status,
            durationMs: Math.round(performance.now() - startedAt),
          })
        );
        sendCapabilityError(response, authorization.status);
        return;
      }
      const uploadId = requestUploadId(request);
      if (isUploadResourceRequest(request) && !uploadId) {
        sendCapabilityError(response, 403);
        return;
      }
      if (uploadId) {
        try {
          const upload = await fileStore.getUpload(uploadId);
          if (versionIdForUpload(upload) !== authorization.versionId) {
            sendCapabilityError(response, 403);
            return;
          }
        } catch {
          sendCapabilityError(response, 403);
          return;
        }
      }
      if (uploadId && request.method === 'PATCH') {
        await withCatalogHeartbeat({
          catalog: input.catalog,
          state: 'UPLOADING',
          versionId: authorization.versionId,
          onHeartbeatError(error) {
            console.error(
              JSON.stringify({
                event: 'ingest_tus.upload_heartbeat_failed',
                uploadId,
                versionId: authorization.versionId,
                ...loggedErrorDetail(error),
              })
            );
          },
          operation: (signal) =>
            heartbeatSignals.run(signal, () =>
              handleTusPatchWithOwnershipSignal({
                handle: () => tusServer.handle(request, response),
                request,
                signal,
              })
            ),
        });
        return;
      }
      await tusServer.handle(request, response);
    })().catch((error) => handleUnexpectedServerError(response, error, startedAt));
  };
}
