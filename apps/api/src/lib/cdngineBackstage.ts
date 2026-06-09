/**
 * Purpose: Handles Backstage package byte transfer through CDNgine without using Convex storage.
 * Governing docs:
 * - README.md
 * - agents.md
 * External references:
 * - CDNgine public API surface and OpenAPI contract in the companion service docs.
 * Tests:
 * - apps/api/src/routes/packages.backstage.test.ts
 * - apps/api/src/routes/backstageRepos.test.ts
 */

import type {
  CdngineBackstageDeliveryReference,
  CdngineBackstageSourceReference,
} from '@yucp/shared/cdngineBackstageDelivery';
import { sha256Hex } from '@yucp/shared/crypto';

export type CdngineBackstageConfig = {
  accessToken: string;
  apiBaseUrl: string;
  deliveryScopeId?: string;
  publicationPollIntervalMs?: number;
  publicationTimeoutMs?: number;
  required?: boolean;
  serviceNamespaceId?: string;
  timeoutMs?: number;
  variant?: string;
};

type ConfiguredCdngineBackstageConfig = {
  accessToken: string;
  apiBaseUrl: string;
  deliveryScopeId: string;
  publicationPollIntervalMs: number;
  publicationTimeoutMs: number;
  serviceNamespaceId: string;
  timeoutMs: number;
  variant: string;
};

export class CdngineApiRequestError extends Error {
  readonly detail: string;
  readonly problemType?: string;
  readonly retryable?: boolean;
  readonly status: number;
  readonly statusText: string;

  constructor(input: {
    detail: string;
    problemType?: string;
    retryable?: boolean;
    status: number;
    statusText: string;
  }) {
    super(`CDNgine request failed: ${input.detail}`);
    this.name = 'CdngineApiRequestError';
    this.detail = input.detail;
    this.problemType = input.problemType;
    this.retryable = input.retryable;
    this.status = input.status;
    this.statusText = input.statusText;
  }
}

type CdngineUploadTarget = {
  expiresAt?: string;
  method: string;
  protocol: string;
  url: string;
};

export type CdngineBackstageUploadSession = {
  assetId?: string;
  uploadSessionId: string;
  uploadTarget: CdngineUploadTarget;
  versionId?: string;
};

const DEFAULT_PUBLICATION_POLL_INTERVAL_MS = 500;
const DEFAULT_PUBLICATION_TIMEOUT_MS = 120_000;

const PENDING_PUBLICATION_STATES = new Set([
  'awaiting-upload',
  'canonicalizing',
  'canonical',
  'processing',
  'session_created',
  'uploaded',
]);

function getFiniteNumberOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined ? value : fallback;
}

function getPositiveNumberOrDefault(value: number | undefined, fallback: number): number {
  const resolved = getFiniteNumberOrDefault(value, fallback);
  return resolved > 0 ? resolved : fallback;
}

function getNonNegativeNumberOrDefault(value: number | undefined, fallback: number): number {
  const resolved = getFiniteNumberOrDefault(value, fallback);
  return resolved >= 0 ? resolved : fallback;
}

export function requireCdngineBackstageConfig(
  config: CdngineBackstageConfig | undefined
): ConfiguredCdngineBackstageConfig {
  if (!config?.apiBaseUrl || !config.accessToken) {
    throw new Error(
      'CDNgine Backstage delivery requires CDNGINE_API_BASE_URL and CDNGINE_ACCESS_TOKEN.'
    );
  }
  return {
    accessToken: config.accessToken,
    apiBaseUrl: config.apiBaseUrl.replace(/\/+$/, ''),
    deliveryScopeId: config.deliveryScopeId ?? 'paid-downloads',
    publicationPollIntervalMs: getNonNegativeNumberOrDefault(
      config.publicationPollIntervalMs,
      DEFAULT_PUBLICATION_POLL_INTERVAL_MS
    ),
    publicationTimeoutMs: getPositiveNumberOrDefault(
      config.publicationTimeoutMs,
      DEFAULT_PUBLICATION_TIMEOUT_MS
    ),
    serviceNamespaceId: config.serviceNamespaceId ?? 'yucp-backstage',
    timeoutMs: config.timeoutMs ?? 15_000,
    variant: config.variant ?? 'vpm-package',
  };
}

export async function sha256ArrayBuffer(bytes: ArrayBuffer): Promise<string> {
  return await sha256Hex(new Uint8Array(bytes));
}

export function sanitizeCdngineObjectKeySegment(value: string): string {
  return value
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._:-]+/g, '-')
    .slice(0, 160);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestCdngineJson<T>(
  config: ConfiguredCdngineBackstageConfig,
  input: {
    body: unknown;
    idempotencyKey: string;
    pathname: string;
  }
): Promise<T> {
  const response = await fetchWithTimeout(
    `${config.apiBaseUrl}${input.pathname}`,
    {
      body: JSON.stringify(input.body),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.accessToken}`,
        'content-type': 'application/json',
        'idempotency-key': input.idempotencyKey,
      },
      method: 'POST',
    },
    config.timeoutMs
  );
  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new Error(
          `CDNgine request failed: ${response.status} ${response.statusText || 'invalid JSON response'}`
        );
      }
      throw new Error('CDNgine response was not valid JSON.');
    }
  }
  if (!response.ok) {
    const detail =
      payload && typeof payload === 'object' && 'detail' in payload
        ? String((payload as { detail?: unknown }).detail)
        : `${response.status} ${response.statusText}`;
    const problemType =
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { type?: unknown }).type === 'string'
        ? (payload as { type: string }).type
        : undefined;
    const retryable =
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { retryable?: unknown }).retryable === 'boolean'
        ? (payload as { retryable: boolean }).retryable
        : undefined;
    throw new CdngineApiRequestError({
      detail,
      problemType,
      retryable,
      status: response.status,
      statusText: response.statusText,
    });
  }
  return payload as T;
}

async function requestCdngineGetJson<T>(
  config: ConfiguredCdngineBackstageConfig,
  input: {
    pathname: string;
  }
): Promise<T> {
  const response = await fetchWithTimeout(
    `${config.apiBaseUrl}${input.pathname}`,
    {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.accessToken}`,
      },
      method: 'GET',
    },
    config.timeoutMs
  );
  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new Error(
          `CDNgine request failed: ${response.status} ${response.statusText || 'invalid JSON response'}`
        );
      }
      throw new Error('CDNgine response was not valid JSON.');
    }
  }
  if (!response.ok) {
    const detail =
      payload && typeof payload === 'object' && 'detail' in payload
        ? String((payload as { detail?: unknown }).detail)
        : `${response.status} ${response.statusText}`;
    const problemType =
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { type?: unknown }).type === 'string'
        ? (payload as { type: string }).type
        : undefined;
    const retryable =
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { retryable?: unknown }).retryable === 'boolean'
        ? (payload as { retryable: boolean }).retryable
        : undefined;
    throw new CdngineApiRequestError({
      detail,
      problemType,
      retryable,
      status: response.status,
      statusText: response.statusText,
    });
  }
  return payload as T;
}

function getStringField(value: unknown, fieldName: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`CDNgine response missing ${fieldName}.`);
  }
  const fieldValue = (value as Record<string, unknown>)[fieldName];
  if (typeof fieldValue !== 'string' || fieldValue.length === 0) {
    throw new Error(`CDNgine response missing ${fieldName}.`);
  }
  return fieldValue;
}

function resolveCdngineUrl(config: ConfiguredCdngineBackstageConfig, value: string): string {
  return new URL(value, `${config.apiBaseUrl}/`).toString();
}

function getOptionalStringField(value: unknown, fieldName: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const fieldValue = (value as Record<string, unknown>)[fieldName];
  return typeof fieldValue === 'string' && fieldValue.length > 0 ? fieldValue : undefined;
}

function getCdngineLifecycleState(value: unknown): string {
  return getStringField(value, 'lifecycleState');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalPublicationFailureState(lifecycleState: string): boolean {
  return (
    lifecycleState === 'quarantined' ||
    lifecycleState === 'purged' ||
    lifecycleState.startsWith('failed_')
  );
}

export async function createBackstageUploadSessionInCdngine(input: {
  byteSize: number;
  config: CdngineBackstageConfig | undefined;
  contentType: string;
  deliveryName: string;
  idempotencyBase: string;
  objectKey: string;
  assetId?: string;
  assetOwner: string;
  tenantId: string;
  sha256: string;
}): Promise<CdngineBackstageUploadSession> {
  const config = requireCdngineBackstageConfig(input.config);
  const session = await requestCdngineJson<unknown>(config, {
    body: {
      ...(input.assetId ? { assetId: input.assetId } : {}),
      assetOwner: input.assetOwner,
      serviceNamespaceId: config.serviceNamespaceId,
      tenantId: input.tenantId,
      source: {
        contentType: input.contentType,
        filename: input.deliveryName,
      },
      upload: {
        byteLength: input.byteSize,
        checksum: {
          algorithm: 'sha256',
          value: input.sha256,
        },
        objectKey: input.objectKey,
      },
    },
    idempotencyKey: `${input.idempotencyBase}:create`,
    pathname: '/v1/upload-sessions',
  });
  const uploadSessionId = getStringField(session, 'uploadSessionId');
  const uploadTarget = (session as { uploadTarget?: unknown }).uploadTarget;

  return {
    assetId: getOptionalStringField(session, 'assetId'),
    uploadSessionId,
    uploadTarget: {
      expiresAt: getOptionalStringField(uploadTarget, 'expiresAt'),
      method: getStringField(uploadTarget, 'method'),
      protocol: getStringField(uploadTarget, 'protocol'),
      url: resolveCdngineUrl(config, getStringField(uploadTarget, 'url')),
    },
    versionId: getOptionalStringField(session, 'versionId'),
  };
}

export async function completeBackstageUploadSessionInCdngine(input: {
  assetOwner: string;
  byteSize: number;
  config: CdngineBackstageConfig | undefined;
  idempotencyBase: string;
  objectKey: string;
  serviceNamespaceId?: string;
  sha256: string;
  tenantId: string;
  uploadSessionId: string;
}): Promise<CdngineBackstageSourceReference> {
  const config = requireCdngineBackstageConfig(input.config);
  const completion = await requestCdngineJson<unknown>(config, {
    body: {
      stagedObject: {
        byteLength: input.byteSize,
        checksum: {
          algorithm: 'sha256',
          value: input.sha256,
        },
        objectKey: input.objectKey,
      },
    },
    idempotencyKey: `${input.idempotencyBase}:complete`,
    pathname: `/v1/upload-sessions/${encodeURIComponent(input.uploadSessionId)}/complete`,
  });

  return {
    assetId: getStringField(completion, 'assetId'),
    assetOwner: input.assetOwner,
    byteSize: input.byteSize,
    serviceNamespaceId: input.serviceNamespaceId ?? config.serviceNamespaceId,
    sha256: input.sha256,
    tenantId: input.tenantId,
    uploadedAt: Date.now(),
    versionId: getStringField(completion, 'versionId'),
  };
}

export async function uploadBackstageBytesToCdngine(input: {
  bytes: ArrayBuffer;
  byteSize: number;
  config: CdngineBackstageConfig | undefined;
  contentType: string;
  deliveryName: string;
  idempotencyBase: string;
  objectKey: string;
  assetId?: string;
  assetOwner: string;
  tenantId: string;
  sha256: string;
}): Promise<CdngineBackstageSourceReference> {
  const config = requireCdngineBackstageConfig(input.config);
  const session = await createBackstageUploadSessionInCdngine({
    byteSize: input.byteSize,
    config,
    contentType: input.contentType,
    deliveryName: input.deliveryName,
    idempotencyBase: input.idempotencyBase,
    objectKey: input.objectKey,
    ...(input.assetId ? { assetId: input.assetId } : {}),
    assetOwner: input.assetOwner,
    tenantId: input.tenantId,
    sha256: input.sha256,
  });

  const uploadResponse = await fetchWithTimeout(
    session.uploadTarget.url,
    {
      body: input.bytes,
      headers: {
        'content-type': 'application/offset+octet-stream',
        'tus-resumable': '1.0.0',
        'upload-offset': '0',
      },
      method: session.uploadTarget.method,
    },
    config.timeoutMs
  );
  if (!uploadResponse.ok) {
    throw new Error(
      `CDNgine upload target rejected the Backstage file with ${uploadResponse.status} ${uploadResponse.statusText}.`
    );
  }

  return completeBackstageUploadSessionInCdngine({
    assetOwner: input.assetOwner,
    byteSize: input.byteSize,
    config,
    idempotencyBase: input.idempotencyBase,
    objectKey: input.objectKey,
    sha256: input.sha256,
    tenantId: input.tenantId,
    uploadSessionId: session.uploadSessionId,
  });
}

/**
 * CDNgine upstream contract:
 * - E:/GitDevelopment/Development/antiwork/cdngine/contracts/arazzo/public-upload.arazzo.yaml
 * - E:/GitDevelopment/Development/antiwork/cdngine/contracts/openapi/public.openapi.yaml#getAssetVersion
 */
export async function waitForCdngineBackstageDeliveryPublication(input: {
  config: CdngineBackstageConfig | undefined;
  delivery: CdngineBackstageDeliveryReference;
}): Promise<void> {
  const config = requireCdngineBackstageConfig(input.config);
  const deadline = Date.now() + config.publicationTimeoutMs;
  let lastLifecycleState = 'unknown';

  while (true) {
    const version = await requestCdngineGetJson<unknown>(config, {
      pathname: `/v1/assets/${encodeURIComponent(input.delivery.assetId)}/versions/${encodeURIComponent(
        input.delivery.versionId
      )}`,
    });
    lastLifecycleState = getCdngineLifecycleState(version);
    if (lastLifecycleState === 'published') {
      return;
    }
    if (isTerminalPublicationFailureState(lastLifecycleState)) {
      throw new Error(
        `CDNgine Backstage deliverable ${input.delivery.assetId}/${input.delivery.versionId} cannot be delivered from lifecycle state "${lastLifecycleState}".`
      );
    }
    if (!PENDING_PUBLICATION_STATES.has(lastLifecycleState)) {
      throw new Error(
        `CDNgine Backstage deliverable ${input.delivery.assetId}/${input.delivery.versionId} returned unexpected lifecycle state "${lastLifecycleState}".`
      );
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `CDNgine Backstage deliverable ${input.delivery.assetId}/${input.delivery.versionId} was not published within ${config.publicationTimeoutMs}ms; last lifecycle state was "${lastLifecycleState}".`
      );
    }
    await sleep(Math.min(config.publicationPollIntervalMs, remainingMs));
  }
}

export async function uploadBackstageDeliverableToCdngine(input: {
  bytes: ArrayBuffer;
  byteSize: number;
  config: CdngineBackstageConfig | undefined;
  contentType: string;
  deliveryName: string;
  releaseId: string;
  assetId?: string;
  assetOwner: string;
  tenantId: string;
  sha256: string;
}): Promise<CdngineBackstageDeliveryReference> {
  const config = requireCdngineBackstageConfig(input.config);
  const objectKey = [
    'staging',
    sanitizeCdngineObjectKeySegment(config.serviceNamespaceId),
    sanitizeCdngineObjectKeySegment(input.tenantId),
    'backstage',
    sanitizeCdngineObjectKeySegment(input.releaseId),
    input.sha256,
    sanitizeCdngineObjectKeySegment(input.deliveryName),
  ].join('/');
  const source = await uploadBackstageBytesToCdngine({
    bytes: input.bytes,
    byteSize: input.byteSize,
    config,
    contentType: input.contentType,
    deliveryName: input.deliveryName,
    idempotencyBase: `backstage-deliverable:${input.releaseId}:${input.sha256}`,
    objectKey,
    ...(input.assetId ? { assetId: input.assetId } : {}),
    assetOwner: input.assetOwner,
    tenantId: input.tenantId,
    sha256: input.sha256,
  });
  const delivery = {
    ...source,
    deliveryScopeId: config.deliveryScopeId,
    variant: config.variant,
  };
  await waitForCdngineBackstageDeliveryPublication({
    config,
    delivery,
  });
  return delivery;
}

export async function authorizeCdngineBackstageSource(input: {
  config: CdngineBackstageConfig | undefined;
  source: CdngineBackstageSourceReference;
  idempotencyKey: string;
}): Promise<string> {
  const config = requireCdngineBackstageConfig(input.config);
  const response = await requestCdngineJson<unknown>(config, {
    body: {
      oneTime: true,
      preferredDisposition: 'attachment',
    },
    idempotencyKey: input.idempotencyKey,
    pathname: `/v1/assets/${encodeURIComponent(input.source.assetId)}/versions/${encodeURIComponent(
      input.source.versionId
    )}/source/authorize`,
  });
  return resolveCdngineUrl(config, getStringField(response, 'url'));
}
