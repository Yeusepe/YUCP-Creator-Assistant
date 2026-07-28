const DELETE_VERSION_PATH = '/v1/internal/catalog/package-versions/delete';
const LIST_VERSIONS_PATH = '/v1/internal/catalog/package-versions';
const VERSION_STATUS_PATH = '/v1/internal/catalog/package-versions/status';
const ACQUIRE_RELEASE_PIN_PATH = '/v1/internal/catalog/release-pins/acquire';
const RELEASE_RELEASE_PIN_PATH = '/v1/internal/catalog/release-pins/release';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const TRACEPARENT_PATTERN = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;
const RESPONSE_LIMIT = 4 * 1024;
const VERSION_PAGE_RESPONSE_LIMIT = 128 * 1024;
const VERSION_PAGE_CURSOR_LIMIT = 2 * 1024;

export type CatalogVersionDeletion = {
  deletedAt: string;
  state: 'DELETED';
  versionId: string;
};

export type CatalogVersionStatusState =
  | 'queued'
  | 'uploading'
  | 'preparing'
  | 'publishing'
  | 'recovering'
  | 'ready'
  | 'failed'
  | 'deleted';

export type CatalogVersionStatus = {
  editionId: string;
  errorCategory: 'processing' | null;
  errorCode: 'PACKAGE_VERSION_PROCESSING_FAILED' | null;
  estimatedStartAt: string | null;
  packageId: string;
  queuePosition: number | null;
  state: CatalogVersionStatusState;
  updatedAt: string;
  version: string;
  versionId: string;
};

export type CatalogVersionListState = Exclude<CatalogVersionStatusState, 'deleted'>;

export type CatalogVersionListItem = {
  createdAt: string;
  editionId: string;
  packageId: string;
  releaseRoot: string | null;
  state: CatalogVersionListState;
  updatedAt: string;
  version: string;
  versionId: string;
};

export type CatalogVersionPage = {
  data: CatalogVersionListItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type CatalogControlPort = {
  deleteVersion(input: {
    editionId: string;
    packageId: string;
    traceparent?: string;
    versionId: string;
  }): Promise<CatalogVersionDeletion>;
  getVersionStatus(input: {
    editionId: string;
    packageId: string;
    traceparent?: string;
    versionId: string;
  }): Promise<CatalogVersionStatus>;
};

export type CatalogVersionListControlPort = {
  listVersions(input: {
    cursor?: string;
    editionId: string;
    limit: number;
    packageId: string;
    traceparent?: string;
  }): Promise<CatalogVersionPage>;
};

export type CatalogReleasePinKind = 'delivery-binding' | 'materialization-job';

export type CatalogReleasePin = {
  expiresAt: string;
  ownerId: string;
  packageVersionId: string;
  pinId: string;
  pinKind: CatalogReleasePinKind;
};

export type CatalogReleasePinControlPort = {
  acquireReleasePin(input: {
    expiresAt: string;
    ownerId: string;
    packageVersionId: string;
    pinKind: CatalogReleasePinKind;
  }): Promise<CatalogReleasePin>;
  releaseReleasePin(input: { pinId: string }): Promise<void>;
};

export type CatalogControlClientConfig = {
  baseUrl: string;
  fetchImplementation?: (request: Request) => Promise<Response>;
  sharedSecret: string;
  timeoutMs?: number;
};

export class CatalogControlClientError extends Error {
  readonly errorCode: string;
  readonly status: number;

  constructor(status: number, errorCode: string) {
    super(`Catalog control rejected the request with ${errorCode}`);
    this.name = 'CatalogControlClientError';
    this.status = status;
    this.errorCode = errorCode;
  }
}

function requireBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Catalog control URL must be an absolute origin');
  }
  const loopbackHttp = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
  if (
    (parsed.protocol !== 'https:' && !loopbackHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Catalog control URL must be an HTTPS or loopback HTTP origin');
  }
  return parsed.origin;
}

function requireText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > maximum
  ) {
    throw new Error(`Catalog control ${name} is invalid`);
  }
  return value;
}

function parseJson(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Catalog control returned an invalid response');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Catalog control returned an invalid response');
  }
  return parsed as Record<string, unknown>;
}

function parseDeletion(body: Record<string, unknown>): CatalogVersionDeletion {
  const deletedAt = requireText(body.deletedAt, 'deletion time', 64);
  if (!Number.isFinite(Date.parse(deletedAt)) || body.state !== 'DELETED') {
    throw new Error('Catalog control returned an invalid response');
  }
  return {
    deletedAt,
    state: 'DELETED',
    versionId: requireText(body.versionId, 'version identifier', 128),
  };
}

function requireTimestamp(value: unknown, name: string): string {
  const timestamp = requireText(value, name, 64);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error('Catalog control returned an invalid response');
  }
  return timestamp;
}

function requireExactKeys(body: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(body).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error('Catalog control returned an invalid response');
  }
}

function requireVersionPageCursor(value: unknown): string {
  const cursor = requireText(value, 'version page cursor', VERSION_PAGE_CURSOR_LIMIT);
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error('Catalog control version page cursor is invalid');
  }
  return cursor;
}

function requireVersionPageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error('Catalog control version page limit is invalid');
  }
  return value;
}

function parseVersionPage(
  body: Record<string, unknown>,
  input: { editionId: string; limit: number; packageId: string }
): CatalogVersionPage {
  requireExactKeys(body, ['data', 'hasMore', 'nextCursor']);
  if (
    !Array.isArray(body.data) ||
    body.data.length > input.limit ||
    typeof body.hasMore !== 'boolean'
  ) {
    throw new Error('Catalog control returned an invalid response');
  }
  const states = new Set<CatalogVersionListState>([
    'queued',
    'uploading',
    'preparing',
    'publishing',
    'recovering',
    'ready',
    'failed',
  ]);
  const data = body.data.map((value): CatalogVersionListItem => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Catalog control returned an invalid response');
    }
    const version = value as Record<string, unknown>;
    requireExactKeys(version, [
      'createdAt',
      'editionId',
      'packageId',
      'releaseRoot',
      'state',
      'updatedAt',
      'version',
      'versionId',
    ]);
    if (
      version.editionId !== input.editionId ||
      version.packageId !== input.packageId ||
      (version.releaseRoot !== null &&
        (typeof version.releaseRoot !== 'string' || !/^[0-9a-f]{64}$/.test(version.releaseRoot))) ||
      typeof version.state !== 'string' ||
      !states.has(version.state as CatalogVersionListState)
    ) {
      throw new Error('Catalog control returned an invalid response');
    }
    return {
      createdAt: requireTimestamp(version.createdAt, 'creation time'),
      editionId: input.editionId,
      packageId: input.packageId,
      releaseRoot: version.releaseRoot as string | null,
      state: version.state as CatalogVersionListState,
      updatedAt: requireTimestamp(version.updatedAt, 'update time'),
      version: requireText(version.version, 'version', 256),
      versionId: requireText(version.versionId, 'version identifier', 128),
    };
  });
  const nextCursor = body.nextCursor === null ? null : requireVersionPageCursor(body.nextCursor);
  if (body.hasMore !== (nextCursor !== null) || (body.hasMore && data.length === 0)) {
    throw new Error('Catalog control returned an invalid response');
  }
  return {
    data,
    hasMore: body.hasMore,
    nextCursor,
  };
}

function parseVersionStatus(body: Record<string, unknown>): CatalogVersionStatus {
  const states = new Set<CatalogVersionStatusState>([
    'queued',
    'uploading',
    'preparing',
    'publishing',
    'recovering',
    'ready',
    'failed',
    'deleted',
  ]);
  if (typeof body.state !== 'string' || !states.has(body.state as CatalogVersionStatusState)) {
    throw new Error('Catalog control returned an invalid response');
  }
  const state = body.state as CatalogVersionStatusState;
  const errorCategory = body.errorCategory;
  const errorCode = body.errorCode;
  if (
    (state === 'failed' &&
      (errorCategory !== 'processing' || errorCode !== 'PACKAGE_VERSION_PROCESSING_FAILED')) ||
    (state !== 'failed' && (errorCategory !== null || errorCode !== null))
  ) {
    throw new Error('Catalog control returned an invalid response');
  }
  const queuePosition = body.queuePosition;
  if (
    queuePosition !== null &&
    (!Number.isSafeInteger(queuePosition) || (queuePosition as number) < 1)
  ) {
    throw new Error('Catalog control returned an invalid response');
  }
  const estimatedStartAt =
    body.estimatedStartAt === null
      ? null
      : requireTimestamp(body.estimatedStartAt, 'estimated start time');
  return {
    editionId: requireText(body.editionId, 'edition identifier', 64),
    errorCategory: errorCategory as CatalogVersionStatus['errorCategory'],
    errorCode: errorCode as CatalogVersionStatus['errorCode'],
    estimatedStartAt,
    packageId: requireText(body.packageId, 'package identifier', 256),
    queuePosition: queuePosition as number | null,
    state,
    updatedAt: requireTimestamp(body.updatedAt, 'update time'),
    version: requireText(body.version, 'version', 256),
    versionId: requireText(body.versionId, 'version identifier', 128),
  };
}

function parseReleasePin(body: Record<string, unknown>): CatalogReleasePin {
  const expiresAt = requireTimestamp(body.expiresAt, 'release pin expiry');
  const pinKind = body.pinKind;
  if (pinKind !== 'delivery-binding' && pinKind !== 'materialization-job') {
    throw new Error('Catalog control returned an invalid response');
  }
  return {
    expiresAt,
    ownerId: requireText(body.ownerId, 'release pin owner', 512),
    packageVersionId: requireText(body.packageVersionId, 'package version identifier', 128),
    pinId: requireText(body.pinId, 'release pin identifier', 128),
    pinKind,
  };
}

function requireReleasePinKind(value: unknown): CatalogReleasePinKind {
  if (value !== 'delivery-binding' && value !== 'materialization-job') {
    throw new Error('Catalog control release pin kind is invalid');
  }
  return value;
}

async function readControlResponse(
  response: Response,
  responseLimit = RESPONSE_LIMIT
): Promise<Record<string, unknown>> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > responseLimit)) {
    throw new Error('Catalog control returned an invalid response');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > responseLimit) {
    throw new Error('Catalog control returned an invalid response');
  }
  return parseJson(text);
}

export function createCatalogControlClient(
  config: CatalogControlClientConfig
): CatalogControlPort & CatalogVersionListControlPort & CatalogReleasePinControlPort {
  const baseUrl = requireBaseUrl(config.baseUrl);
  const sharedSecret = config.sharedSecret.trim();
  if (Buffer.byteLength(sharedSecret, 'utf8') < 32) {
    throw new Error('Catalog control shared secret must contain at least 32 UTF-8 bytes');
  }
  const timeoutMs = config.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('Catalog control timeout is invalid');
  }
  const fetchImplementation = config.fetchImplementation ?? ((request: Request) => fetch(request));

  return {
    async acquireReleasePin(input) {
      const response = await fetchImplementation(
        new Request(`${baseUrl}${ACQUIRE_RELEASE_PIN_PATH}`, {
          body: JSON.stringify({
            expiresAt: requireTimestamp(input.expiresAt, 'release pin expiry'),
            ownerId: requireText(input.ownerId, 'release pin owner', 512),
            packageVersionId: requireText(
              input.packageVersionId,
              'package version identifier',
              128
            ),
            pinKind: requireReleasePinKind(input.pinKind),
          }),
          headers: {
            Authorization: `Bearer ${sharedSecret}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
        })
      );
      const body = await readControlResponse(response);
      if (response.status !== 200) {
        throw new CatalogControlClientError(
          response.status,
          requireText(body.errorCode, 'error code', 128)
        );
      }
      const pin = parseReleasePin(body);
      if (
        pin.expiresAt !== input.expiresAt ||
        pin.ownerId !== input.ownerId ||
        pin.packageVersionId !== input.packageVersionId ||
        pin.pinKind !== input.pinKind
      ) {
        throw new Error('Catalog control returned an invalid response');
      }
      return pin;
    },
    async getVersionStatus(input) {
      if (input.traceparent && !TRACEPARENT_PATTERN.test(input.traceparent)) {
        throw new Error('Catalog control trace context is invalid');
      }
      const url = new URL(`${baseUrl}${VERSION_STATUS_PATH}`);
      url.searchParams.set('editionId', requireText(input.editionId, 'edition identifier', 64));
      url.searchParams.set('packageId', requireText(input.packageId, 'package identifier', 256));
      url.searchParams.set('versionId', requireText(input.versionId, 'version identifier', 128));
      const response = await fetchImplementation(
        new Request(url, {
          headers: {
            Authorization: `Bearer ${sharedSecret}`,
            ...(input.traceparent ? { traceparent: input.traceparent } : {}),
          },
          method: 'GET',
          signal: AbortSignal.timeout(timeoutMs),
        })
      );
      const body = await readControlResponse(response);
      if (response.status !== 200) {
        throw new CatalogControlClientError(
          response.status,
          requireText(body.errorCode, 'error code', 128)
        );
      }
      return parseVersionStatus(body);
    },
    async listVersions(input) {
      if (input.traceparent && !TRACEPARENT_PATTERN.test(input.traceparent)) {
        throw new Error('Catalog control trace context is invalid');
      }
      const editionId = requireText(input.editionId, 'edition identifier', 64);
      const limit = requireVersionPageLimit(input.limit);
      const packageId = requireText(input.packageId, 'package identifier', 256);
      const url = new URL(`${baseUrl}${LIST_VERSIONS_PATH}`);
      if (input.cursor) {
        url.searchParams.set('cursor', requireVersionPageCursor(input.cursor));
      }
      url.searchParams.set('editionId', editionId);
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('packageId', packageId);
      const response = await fetchImplementation(
        new Request(url, {
          headers: {
            Authorization: `Bearer ${sharedSecret}`,
            ...(input.traceparent ? { traceparent: input.traceparent } : {}),
          },
          method: 'GET',
          signal: AbortSignal.timeout(timeoutMs),
        })
      );
      const body = await readControlResponse(response, VERSION_PAGE_RESPONSE_LIMIT);
      if (response.status !== 200) {
        throw new CatalogControlClientError(
          response.status,
          requireText(body.errorCode, 'error code', 128)
        );
      }
      return parseVersionPage(body, { editionId, limit, packageId });
    },
    async deleteVersion(input) {
      if (input.traceparent && !TRACEPARENT_PATTERN.test(input.traceparent)) {
        throw new Error('Catalog control trace context is invalid');
      }
      const response = await fetchImplementation(
        new Request(`${baseUrl}${DELETE_VERSION_PATH}`, {
          body: JSON.stringify({
            editionId: requireText(input.editionId, 'edition identifier', 64),
            packageId: requireText(input.packageId, 'package identifier', 256),
            versionId: requireText(input.versionId, 'version identifier', 128),
          }),
          headers: {
            Authorization: `Bearer ${sharedSecret}`,
            'Content-Type': 'application/json',
            ...(input.traceparent ? { traceparent: input.traceparent } : {}),
          },
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
        })
      );
      const body = await readControlResponse(response);
      if (response.status !== 200) {
        throw new CatalogControlClientError(
          response.status,
          requireText(body.errorCode, 'error code', 128)
        );
      }
      return parseDeletion(body);
    },
    async releaseReleasePin(input) {
      const pinId = requireText(input.pinId, 'release pin identifier', 128);
      const response = await fetchImplementation(
        new Request(`${baseUrl}${RELEASE_RELEASE_PIN_PATH}`, {
          body: JSON.stringify({ pinId }),
          headers: {
            Authorization: `Bearer ${sharedSecret}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
        })
      );
      const body = await readControlResponse(response);
      if (response.status !== 200) {
        throw new CatalogControlClientError(
          response.status,
          requireText(body.errorCode, 'error code', 128)
        );
      }
      if (body.pinId !== pinId || body.released !== true) {
        throw new Error('Catalog control returned an invalid response');
      }
    },
  };
}

export function loadCatalogControlClient(env: {
  PACKAGE_CATALOG_CONTROL_INTERNAL_BASE_URL?: string;
  PACKAGE_CATALOG_CONTROL_SHARED_SECRET?: string;
  PACKAGE_CATALOG_CONTROL_TIMEOUT_MS?: string;
}): (CatalogControlPort & CatalogVersionListControlPort & CatalogReleasePinControlPort) | null {
  const baseUrl = env.PACKAGE_CATALOG_CONTROL_INTERNAL_BASE_URL?.trim();
  const sharedSecret = env.PACKAGE_CATALOG_CONTROL_SHARED_SECRET?.trim();
  if (!baseUrl && !sharedSecret) {
    return null;
  }
  if (!baseUrl || !sharedSecret) {
    throw new Error(
      'PACKAGE_CATALOG_CONTROL_INTERNAL_BASE_URL and PACKAGE_CATALOG_CONTROL_SHARED_SECRET must be configured together'
    );
  }
  const timeoutText = env.PACKAGE_CATALOG_CONTROL_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutText ? Number(timeoutText) : undefined;
  return createCatalogControlClient({
    baseUrl,
    sharedSecret,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}
