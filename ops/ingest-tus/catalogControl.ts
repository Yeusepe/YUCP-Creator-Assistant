import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import {
  DEFAULT_MAX_ATTEMPTS,
  IllegalCatalogTransitionError,
  isCatalogVersionRedriveEligible,
  PackageVersionNotFoundError,
  resolveRetryPolicy,
} from '../catalog';

export const CATALOG_DELETE_VERSION_PATH = '/v1/internal/catalog/package-versions/delete' as const;
export const CATALOG_LIST_VERSIONS_PATH = '/v1/internal/catalog/package-versions' as const;
export const CATALOG_VERSION_STATUS_PATH = '/v1/internal/catalog/package-versions/status' as const;
export const CATALOG_ACQUIRE_RELEASE_PIN_PATH =
  '/v1/internal/catalog/release-pins/acquire' as const;
export const CATALOG_RELEASE_RELEASE_PIN_PATH =
  '/v1/internal/catalog/release-pins/release' as const;

const BODY_LIMIT = 4 * 1024;
const DEFAULT_VERSION_PAGE_LIMIT = 50;
const MAX_VERSION_PAGE_LIMIT = 100;
const VERSION_PAGE_CURSOR_LIMIT = 2 * 1024;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

type CatalogControlPort = {
  deleteVersion(
    versionId: string,
    input: { editionId: string; packageId: string; reason: string }
  ): Promise<{
    deletedAt: Date | null;
    id: string;
    state: string;
  }>;
  getVersion(versionId: string): Promise<{
    assemblyObjectId?: string | null;
    attempts?: number;
    editionId?: string;
    error?: string | null;
    nextAttemptAt?: Date | null;
    packageId: string;
    releaseRoot?: string | null;
    sourceFormat?: string | null;
    state?: string;
    updatedAt?: Date;
    version?: string;
  } | null>;
  listVersionsPage(
    packageId: string,
    input: {
      cursor?: { createdAt: Date; versionId: string };
      editionId: string;
      limit: number;
    }
  ): Promise<{
    data: Array<{
      createdAt: Date;
      editionId: string;
      id: string;
      assemblyObjectId?: string | null;
      attempts?: number;
      packageId: string;
      releaseRoot: string | null;
      nextAttemptAt?: Date | null;
      sourceFormat?: string | null;
      state: string;
      updatedAt: Date;
      version: string;
    }>;
    hasMore: boolean;
    nextCursor: { createdAt: Date; versionId: string } | null;
  }>;
};

type ReleasePinControlPort = {
  createReleasePin(input: {
    expiresAt: Date;
    ownerId: string;
    packageVersionId: string;
    pinKind: 'delivery-binding' | 'materialization-job';
  }): Promise<{
    expiresAt: Date | null;
    id: string;
    ownerId: string;
    packageVersionId: string;
    pinKind: string;
    releasedAt: Date | null;
  }>;
  releaseReleasePin(pinId: string): Promise<void>;
};

export type CatalogControlEvent = {
  durationMs: number;
  errorCode?: string;
  event:
    | 'catalog.release_pin.acquire'
    | 'catalog.release_pin.release'
    | 'catalog.version.delete_command'
    | 'catalog.version.list_read'
    | 'catalog.version.status_read';
  status: 'accepted' | 'rejected';
  traceId: string;
  versionId?: string;
};

export interface CatalogControlHandlerInput {
  catalog: CatalogControlPort;
  maxAttempts?: number;
  onEvent?: (event: CatalogControlEvent) => void;
  releasePins?: ReleasePinControlPort;
  sharedSecret: string;
}

class ControlBoundaryError extends Error {
  readonly errorCode: string;
  readonly status: number;

  constructor(status: number, errorCode: string) {
    super(errorCode);
    this.name = 'ControlBoundaryError';
    this.status = status;
    this.errorCode = errorCode;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown, traceId: string): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(encoded),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Trace-Id': traceId,
  });
  response.end(encoded);
}

function authorizationMatches(header: string | undefined, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8');
  const actual = Buffer.from(header ?? '', 'utf8');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value.trim() && !value.includes(',')
    ? value.trim()
    : undefined;
}

function traceIdForRequest(request: IncomingMessage): string {
  const match = TRACEPARENT_PATTERN.exec(singleHeader(request, 'traceparent') ?? '');
  if (match?.[1] && match[2] && !/^0{32}$/.test(match[1]) && !/^0{16}$/.test(match[2])) {
    return match[1];
  }
  return randomBytes(16).toString('hex');
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = singleHeader(request, 'content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new ControlBoundaryError(415, 'CATALOG_CONTROL_CONTENT_TYPE_INVALID');
  }
  const declaredLength = singleHeader(request, 'content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > BODY_LIMIT)) {
    throw new ControlBoundaryError(413, 'CATALOG_CONTROL_REQUEST_TOO_LARGE');
  }

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > BODY_LIMIT) {
      throw new ControlBoundaryError(413, 'CATALOG_CONTROL_REQUEST_TOO_LARGE');
    }
    chunks.push(bytes);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ControlBoundaryError(400, 'CATALOG_CONTROL_REQUEST_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ControlBoundaryError(400, 'CATALOG_CONTROL_REQUEST_INVALID');
  }
  return parsed as Record<string, unknown>;
}

function requireIdentifier(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > maximum
  ) {
    throw new ControlBoundaryError(400, 'CATALOG_CONTROL_REQUEST_INVALID');
  }
  return value;
}

function emitEvent(input: CatalogControlHandlerInput, event: CatalogControlEvent): void {
  if (input.onEvent) {
    input.onEvent(event);
    return;
  }
  console.info(JSON.stringify(event));
}

export function isCatalogControlRequest(request: IncomingMessage): boolean {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  return (
    pathname === CATALOG_ACQUIRE_RELEASE_PIN_PATH ||
    pathname === CATALOG_DELETE_VERSION_PATH ||
    pathname === CATALOG_LIST_VERSIONS_PATH ||
    pathname === CATALOG_RELEASE_RELEASE_PIN_PATH ||
    pathname === CATALOG_VERSION_STATUS_PATH
  );
}

function requireExactBodyKeys(body: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(body).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new ControlBoundaryError(400, 'CATALOG_CONTROL_REQUEST_INVALID');
  }
}

function requireFutureTimestamp(value: unknown): Date {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new ControlBoundaryError(400, 'CATALOG_CONTROL_REQUEST_INVALID');
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.getTime() <= Date.now()) {
    throw new ControlBoundaryError(400, 'CATALOG_CONTROL_REQUEST_INVALID');
  }
  return timestamp;
}

function requirePinKind(value: unknown): 'delivery-binding' | 'materialization-job' {
  if (value !== 'delivery-binding' && value !== 'materialization-job') {
    throw new ControlBoundaryError(400, 'CATALOG_CONTROL_REQUEST_INVALID');
  }
  return value;
}

function readStatusIdentity(request: IncomingMessage): {
  editionId: string;
  packageId: string;
  versionId: string;
} {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const keys = Array.from(url.searchParams.keys()).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'editionId' ||
    keys[1] !== 'packageId' ||
    keys[2] !== 'versionId' ||
    url.searchParams.getAll('editionId').length !== 1 ||
    url.searchParams.getAll('packageId').length !== 1 ||
    url.searchParams.getAll('versionId').length !== 1
  ) {
    throw new ControlBoundaryError(400, 'CATALOG_CONTROL_REQUEST_INVALID');
  }
  return {
    editionId: requireIdentifier(url.searchParams.get('editionId'), 64),
    packageId: requireIdentifier(url.searchParams.get('packageId'), 256),
    versionId: requireIdentifier(url.searchParams.get('versionId'), 128),
  };
}

function decodeVersionPageCursor(
  value: string,
  identity: { editionId: string; packageId: string }
): { createdAt: Date; versionId: string } {
  if (!value || value.length > VERSION_PAGE_CURSOR_LIMIT || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ControlBoundaryError(400, 'CATALOG_CONTROL_REQUEST_INVALID');
  }
  let decoded: Buffer;
  let parsed: unknown;
  try {
    decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) {
      throw new Error('Noncanonical cursor');
    }
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
  } catch {
    throw new ControlBoundaryError(400, 'CATALOG_CONTROL_REQUEST_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ControlBoundaryError(400, 'CATALOG_CONTROL_REQUEST_INVALID');
  }
  const body = parsed as Record<string, unknown>;
  requireExactBodyKeys(body, ['createdAt', 'editionId', 'packageId', 'versionId']);
  const editionId = requireIdentifier(body.editionId, 64);
  const packageId = requireIdentifier(body.packageId, 256);
  const createdAtText = requireIdentifier(body.createdAt, 64);
  const versionId = requireIdentifier(body.versionId, 128);
  const createdAt = new Date(createdAtText);
  if (
    editionId !== identity.editionId ||
    packageId !== identity.packageId ||
    !Number.isFinite(createdAt.getTime()) ||
    createdAt.toISOString() !== createdAtText
  ) {
    throw new ControlBoundaryError(400, 'CATALOG_CONTROL_REQUEST_INVALID');
  }
  return { createdAt, versionId };
}

function encodeVersionPageCursor(input: {
  createdAt: Date;
  editionId: string;
  packageId: string;
  versionId: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: input.createdAt.toISOString(),
      editionId: input.editionId,
      packageId: input.packageId,
      versionId: input.versionId,
    })
  ).toString('base64url');
}

function readVersionPageRequest(request: IncomingMessage): {
  cursor?: { createdAt: Date; versionId: string };
  editionId: string;
  limit: number;
  packageId: string;
} {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const allowedKeys = new Set(['cursor', 'editionId', 'limit', 'packageId']);
  const keys = Array.from(url.searchParams.keys());
  if (
    keys.some((key) => !allowedKeys.has(key)) ||
    url.searchParams.getAll('editionId').length !== 1 ||
    url.searchParams.getAll('packageId').length !== 1 ||
    url.searchParams.getAll('limit').length > 1 ||
    url.searchParams.getAll('cursor').length > 1
  ) {
    throw new ControlBoundaryError(400, 'CATALOG_CONTROL_REQUEST_INVALID');
  }
  const editionId = requireIdentifier(url.searchParams.get('editionId'), 64);
  const packageId = requireIdentifier(url.searchParams.get('packageId'), 256);
  const limitText = url.searchParams.get('limit') ?? String(DEFAULT_VERSION_PAGE_LIMIT);
  if (!/^[1-9]\d{0,2}$/.test(limitText)) {
    throw new ControlBoundaryError(400, 'CATALOG_CONTROL_REQUEST_INVALID');
  }
  const limit = Number(limitText);
  if (limit > MAX_VERSION_PAGE_LIMIT) {
    throw new ControlBoundaryError(400, 'CATALOG_CONTROL_REQUEST_INVALID');
  }
  const cursorText = url.searchParams.get('cursor');
  return {
    editionId,
    limit,
    packageId,
    ...(cursorText
      ? { cursor: decodeVersionPageCursor(cursorText, { editionId, packageId }) }
      : {}),
  };
}

function publicVersionState(
  version: Parameters<typeof isCatalogVersionRedriveEligible>[0],
  maxAttempts: number
):
  | 'queued'
  | 'uploading'
  | 'preparing'
  | 'publishing'
  | 'recovering'
  | 'ready'
  | 'failed'
  | 'deleted' {
  if (isCatalogVersionRedriveEligible(version, maxAttempts)) {
    return 'recovering';
  }
  switch (version.state) {
    case 'CREATED':
      return 'queued';
    case 'UPLOADING':
      return 'uploading';
    case 'ASSEMBLED':
      return 'preparing';
    case 'PROMOTING':
      return 'publishing';
    case 'READY':
      return 'ready';
    case 'FAILED':
      return 'failed';
    case 'DELETED':
      return 'deleted';
    default:
      throw new Error('Catalog returned an invalid package version state');
  }
}

export function createCatalogControlHandler(input: CatalogControlHandlerInput): RequestListener {
  const sharedSecret = input.sharedSecret.trim();
  if (Buffer.byteLength(sharedSecret, 'utf8') < 32) {
    throw new Error('Catalog control shared secret must contain at least 32 UTF-8 bytes');
  }
  const maxAttempts = resolveRetryPolicy({
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  }).maxAttempts;

  return (request, response) => {
    const startedAt = performance.now();
    const traceId = traceIdForRequest(request);
    let versionId: string | undefined;
    let eventName: CatalogControlEvent['event'] = 'catalog.version.delete_command';
    void (async () => {
      if (!isCatalogControlRequest(request)) {
        throw new ControlBoundaryError(404, 'CATALOG_CONTROL_ROUTE_NOT_FOUND');
      }
      if (!authorizationMatches(singleHeader(request, 'authorization'), sharedSecret)) {
        throw new ControlBoundaryError(401, 'CATALOG_CONTROL_AUTH_REQUIRED');
      }
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname === CATALOG_LIST_VERSIONS_PATH) {
        eventName = 'catalog.version.list_read';
        if (request.method !== 'GET') {
          throw new ControlBoundaryError(405, 'CATALOG_CONTROL_METHOD_NOT_ALLOWED');
        }
        const identity = readVersionPageRequest(request);
        const page = await input.catalog.listVersionsPage(identity.packageId, {
          ...(identity.cursor ? { cursor: identity.cursor } : {}),
          editionId: identity.editionId,
          limit: identity.limit,
        });
        if (
          !Array.isArray(page.data) ||
          page.data.length > identity.limit ||
          typeof page.hasMore !== 'boolean' ||
          page.hasMore !== (page.nextCursor !== null)
        ) {
          throw new Error('Catalog returned an invalid package version page');
        }
        const data = page.data.map((version) => {
          if (
            version.packageId !== identity.packageId ||
            version.editionId !== identity.editionId ||
            !(version.createdAt instanceof Date) ||
            !Number.isFinite(version.createdAt.getTime()) ||
            !(version.updatedAt instanceof Date) ||
            !Number.isFinite(version.updatedAt.getTime()) ||
            !version.id ||
            !version.version ||
            (version.releaseRoot !== null && !/^[0-9a-f]{64}$/.test(version.releaseRoot)) ||
            version.state === 'DELETED'
          ) {
            throw new Error('Catalog returned an invalid package version page');
          }
          return {
            createdAt: version.createdAt.toISOString(),
            editionId: version.editionId,
            packageId: version.packageId,
            releaseRoot: version.releaseRoot,
            state: publicVersionState(version, maxAttempts),
            updatedAt: version.updatedAt.toISOString(),
            version: version.version,
            versionId: version.id,
          };
        });
        const last = page.data.at(-1);
        if (
          page.nextCursor &&
          (!last ||
            !Number.isFinite(page.nextCursor.createdAt.getTime()) ||
            page.nextCursor.createdAt.getTime() !== last.createdAt.getTime() ||
            page.nextCursor.versionId !== last.id)
        ) {
          throw new Error('Catalog returned an invalid package version page');
        }
        emitEvent(input, {
          durationMs: Math.round(performance.now() - startedAt),
          event: eventName,
          status: 'accepted',
          traceId,
        });
        sendJson(
          response,
          200,
          {
            data,
            hasMore: page.hasMore,
            nextCursor: page.nextCursor
              ? encodeVersionPageCursor({
                  ...page.nextCursor,
                  editionId: identity.editionId,
                  packageId: identity.packageId,
                })
              : null,
          },
          traceId
        );
        return;
      }
      if (pathname === CATALOG_VERSION_STATUS_PATH) {
        eventName = 'catalog.version.status_read';
        if (request.method !== 'GET') {
          throw new ControlBoundaryError(405, 'CATALOG_CONTROL_METHOD_NOT_ALLOWED');
        }
        const identity = readStatusIdentity(request);
        versionId = identity.versionId;
        const current = await input.catalog.getVersion(versionId);
        if (
          !current ||
          current.packageId !== identity.packageId ||
          current.editionId !== identity.editionId
        ) {
          throw new ControlBoundaryError(404, 'PACKAGE_VERSION_NOT_FOUND');
        }
        if (
          !current.version ||
          !current.updatedAt ||
          !Number.isFinite(current.updatedAt.getTime())
        ) {
          throw new Error('Catalog returned an invalid package version status');
        }
        const state = publicVersionState(current, maxAttempts);
        emitEvent(input, {
          durationMs: Math.round(performance.now() - startedAt),
          event: eventName,
          status: 'accepted',
          traceId,
          versionId,
        });
        sendJson(
          response,
          200,
          {
            editionId: current.editionId,
            errorCategory: state === 'failed' ? 'processing' : null,
            errorCode: state === 'failed' ? 'PACKAGE_VERSION_PROCESSING_FAILED' : null,
            estimatedStartAt:
              state === 'recovering' && current.nextAttemptAt
                ? current.nextAttemptAt.toISOString()
                : null,
            packageId: current.packageId,
            queuePosition: null,
            state,
            updatedAt: current.updatedAt.toISOString(),
            version: current.version,
            versionId,
          },
          traceId
        );
        return;
      }
      if (request.method !== 'POST') {
        throw new ControlBoundaryError(405, 'CATALOG_CONTROL_METHOD_NOT_ALLOWED');
      }

      const body = await readBody(request);
      if (pathname === CATALOG_ACQUIRE_RELEASE_PIN_PATH) {
        eventName = 'catalog.release_pin.acquire';
        if (!input.releasePins) {
          throw new ControlBoundaryError(503, 'CATALOG_RELEASE_PINS_UNAVAILABLE');
        }
        requireExactBodyKeys(body, ['expiresAt', 'ownerId', 'packageVersionId', 'pinKind']);
        const expiresAt = requireFutureTimestamp(body.expiresAt);
        const ownerId = requireIdentifier(body.ownerId, 512);
        versionId = requireIdentifier(body.packageVersionId, 128);
        const pinKind = requirePinKind(body.pinKind);
        const pin = await input.releasePins.createReleasePin({
          expiresAt,
          ownerId,
          packageVersionId: versionId,
          pinKind,
        });
        if (
          pin.packageVersionId !== versionId ||
          pin.ownerId !== ownerId ||
          pin.pinKind !== pinKind ||
          !pin.expiresAt ||
          pin.expiresAt.getTime() !== expiresAt.getTime() ||
          pin.releasedAt !== null
        ) {
          throw new Error('Catalog returned an invalid storage GC pin');
        }
        emitEvent(input, {
          durationMs: Math.round(performance.now() - startedAt),
          event: eventName,
          status: 'accepted',
          traceId,
          versionId,
        });
        sendJson(
          response,
          200,
          {
            expiresAt: pin.expiresAt.toISOString(),
            ownerId: pin.ownerId,
            packageVersionId: pin.packageVersionId,
            pinId: pin.id,
            pinKind: pin.pinKind,
          },
          traceId
        );
        return;
      }
      if (pathname === CATALOG_RELEASE_RELEASE_PIN_PATH) {
        eventName = 'catalog.release_pin.release';
        if (!input.releasePins) {
          throw new ControlBoundaryError(503, 'CATALOG_RELEASE_PINS_UNAVAILABLE');
        }
        requireExactBodyKeys(body, ['pinId']);
        const pinId = requireIdentifier(body.pinId, 128);
        await input.releasePins.releaseReleasePin(pinId);
        emitEvent(input, {
          durationMs: Math.round(performance.now() - startedAt),
          event: eventName,
          status: 'accepted',
          traceId,
        });
        sendJson(response, 200, { pinId, released: true }, traceId);
        return;
      }
      requireExactBodyKeys(body, ['editionId', 'packageId', 'versionId']);
      const editionId = requireIdentifier(body.editionId, 64);
      const packageId = requireIdentifier(body.packageId, 256);
      versionId = requireIdentifier(body.versionId, 128);
      const current = await input.catalog.getVersion(versionId);
      if (!current || current.packageId !== packageId || current.editionId !== editionId) {
        throw new ControlBoundaryError(404, 'PACKAGE_VERSION_NOT_FOUND');
      }

      const deleted = await input.catalog.deleteVersion(versionId, {
        editionId,
        packageId,
        reason: 'creator-request',
      });
      if (deleted.state !== 'DELETED' || !deleted.deletedAt) {
        throw new Error('Catalog returned an invalid deletion result');
      }
      emitEvent(input, {
        durationMs: Math.round(performance.now() - startedAt),
        event: eventName,
        status: 'accepted',
        traceId,
        versionId,
      });
      sendJson(
        response,
        200,
        {
          deletedAt: deleted.deletedAt.toISOString(),
          state: 'DELETED',
          versionId: deleted.id,
        },
        traceId
      );
    })().catch((error: unknown) => {
      let status = 500;
      let errorCode = 'CATALOG_CONTROL_FAILED';
      if (error instanceof ControlBoundaryError) {
        status = error.status;
        errorCode = error.errorCode;
      } else if (error instanceof PackageVersionNotFoundError) {
        status = 404;
        errorCode = 'PACKAGE_VERSION_NOT_FOUND';
      } else if (error instanceof IllegalCatalogTransitionError) {
        status = 409;
        errorCode = 'PACKAGE_VERSION_DELETE_BLOCKED';
      }
      emitEvent(input, {
        durationMs: Math.round(performance.now() - startedAt),
        errorCode,
        event: eventName,
        status: 'rejected',
        traceId,
        ...(versionId ? { versionId } : {}),
      });
      sendJson(response, status, { errorCode }, traceId);
    });
  };
}
