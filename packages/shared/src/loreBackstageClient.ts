import { blake3 } from '@noble/hashes/blake3.js';

export type LoreBackstageConfig = {
  apiBaseUrl: string;
  presignHmacKey?: string;
  repoNamespaceSalt: string;
  accessClientId: string;
  accessClientSecret: string;
  timeoutMs?: number;
  defaultTtlSeconds?: number;
};

export type ConfiguredLoreBackstageConfig = Required<Omit<LoreBackstageConfig, 'presignHmacKey'>> &
  Pick<LoreBackstageConfig, 'presignHmacKey'>;

export class LoreApiRequestError extends Error {
  readonly detail: string;
  readonly status?: number;
  readonly statusText?: string;

  constructor(input: { detail: string; status?: number; statusText?: string }) {
    super(`Lore request failed: ${input.detail}`);
    this.name = 'LoreApiRequestError';
    this.detail = input.detail;
    this.status = input.status;
    this.statusText = input.statusText;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TTL_SECONDS = 3_600;
const LORE_RESPONSE_MAX_BYTES = 16 * 1024;
const HEX_RE = /^[0-9a-f]+$/i;
const REPOSITORY_ID_RE = /^[0-9a-f]{32}$/;
const ADDRESS_RE = /^[0-9a-f]{64}-[0-9a-f]{32}$/;

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value >= 1 ? Math.floor(value) : fallback;
}

function requireNonEmpty(value: string | undefined, variableName: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Lore Backstage storage requires ${variableName}.`);
  }
  return normalized;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f /* '/' */) end -= 1;
  return value.slice(0, end);
}

function normalizeLoreApiBaseUrl(url: URL): string {
  return `${url.origin}${trimTrailingSlashes(url.pathname)}`;
}

function hexDecode(value: string, fieldName: string): Uint8Array<ArrayBuffer> {
  if (value.length % 2 !== 0 || !HEX_RE.test(value)) {
    throw new Error(`${fieldName} must be an even-length hexadecimal string.`);
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function asOwnedBytes(bytes: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : (bytes as Uint8Array<ArrayBuffer>);
}

function base64UrlNoPad(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function validateRepositoryId(repositoryId: string): void {
  if (!REPOSITORY_ID_RE.test(repositoryId)) {
    throw new Error('Lore repositoryId must be exactly 32 lowercase hexadecimal characters.');
  }
}

function validateAddress(address: string): void {
  if (!ADDRESS_RE.test(address)) {
    throw new Error('Lore address must match <64 lowercase hex>-<32 lowercase hex>.');
  }
}

function isHttpTrustedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '127.0.0.1' || h.startsWith('127.') || h === '::1') return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (!h.includes('.')) return true;
  if (/\.(internal|local|cluster\.local|svc|svc\.cluster\.local|lan|home\.arpa)$/.test(h)) {
    return true;
  }
  return false;
}

// ponytail: Callers pin jobUrl to the authorized tusEndpoint origin, credentialed fetches use
// redirect: 'error', and URLs require HTTPS or a trusted loopback/private host. Static host
// allowlists and post-DNS-resolution IP checks for DNS-rebind protection are intentionally
// omitted because Lore hosts are operator-configurable and browser clients have no DNS API.
export function assertSecureLoreUrl(rawUrl: string, fieldName: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${fieldName} must be a valid HTTP or HTTPS URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${fieldName} must be a valid HTTP or HTTPS URL.`);
  }
  if (url.protocol === 'http:' && !isHttpTrustedHost(url.hostname)) {
    throw new Error(
      `${fieldName} must use HTTPS (plaintext HTTP is only allowed for loopback/private/internal hosts).`
    );
  }
  return url;
}

export function requireLoreBackstageConfig(
  config: LoreBackstageConfig | undefined
): ConfiguredLoreBackstageConfig {
  const apiBaseUrlValue = requireNonEmpty(config?.apiBaseUrl, 'LORE_API_BASE_URL');
  const apiBaseUrl = assertSecureLoreUrl(apiBaseUrlValue, 'LORE_API_BASE_URL');
  if (apiBaseUrl.search || apiBaseUrl.hash) {
    throw new Error('LORE_API_BASE_URL must not contain a query string or fragment.');
  }

  const presignHmacKey = config?.presignHmacKey?.trim().toLowerCase();
  if (presignHmacKey) {
    const keyBytes = hexDecode(presignHmacKey, 'LORE_PRESIGN_HMAC_KEY');
    if (keyBytes.byteLength < 32) {
      throw new Error('LORE_PRESIGN_HMAC_KEY must decode to at least 32 bytes.');
    }
  }

  return {
    apiBaseUrl: normalizeLoreApiBaseUrl(apiBaseUrl),
    presignHmacKey,
    repoNamespaceSalt: requireNonEmpty(config?.repoNamespaceSalt, 'LORE_REPO_NAMESPACE_SALT'),
    accessClientId: requireNonEmpty(config?.accessClientId, 'LORE_ACCESS_CLIENT_ID'),
    accessClientSecret: requireNonEmpty(config?.accessClientSecret, 'LORE_ACCESS_CLIENT_SECRET'),
    timeoutMs: positiveIntegerOrDefault(config?.timeoutMs, DEFAULT_TIMEOUT_MS),
    defaultTtlSeconds: positiveIntegerOrDefault(config?.defaultTtlSeconds, DEFAULT_TTL_SECONDS),
  };
}

export function loreRepositoryIdForCreator(authUserId: string, salt: string): string {
  return toHex(blake3(new TextEncoder().encode(`${salt}:${authUserId}`))).slice(0, 32);
}

export async function sha256ArrayBuffer(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const ownedBytes = asOwnedBytes(bytes);
  const digest = await crypto.subtle.digest('SHA-256', ownedBytes);
  return toHex(new Uint8Array(digest));
}

type BoundedText = {
  text: string;
  truncated: boolean;
};

async function readResponseTextBounded(response: Response, maxBytes: number): Promise<BoundedText> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { text: '', truncated: false };
  }

  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  let truncated = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const remainingBytes = maxBytes - totalBytes;
      if (chunk.value.byteLength > remainingBytes) {
        text += decoder.decode(chunk.value.subarray(0, Math.max(remainingBytes, 0)), {
          stream: true,
        });
        truncated = true;
        await reader.cancel('Lore response body exceeded limit').catch(() => undefined);
        break;
      }
      totalBytes += chunk.value.byteLength;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return { text: text + decoder.decode(), truncated };
}

function accessHeaders(config: ConfiguredLoreBackstageConfig): HeadersInit {
  return {
    'CF-Access-Client-Id': config.accessClientId,
    'CF-Access-Client-Secret': config.accessClientSecret,
  };
}

function throwLoreResponseError(response: Response, _boundedText: BoundedText): never {
  const detail = `${response.status} ${response.statusText}`.trim();
  throw new LoreApiRequestError({
    detail,
    status: response.status,
    statusText: response.statusText,
  });
}

async function putBackstageBodyToLoreRequest(input: {
  config: ConfiguredLoreBackstageConfig;
  repositoryId: string;
  body: BodyInit;
}): Promise<string> {
  validateRepositoryId(input.repositoryId);
  let response: Response;
  try {
    response = await fetch(
      `${input.config.apiBaseUrl}/v1/repository/${input.repositoryId}/content`,
      {
        body: input.body,
        headers: accessHeaders(input.config),
        method: 'PUT',
        redirect: 'error',
        signal: AbortSignal.timeout(input.config.timeoutMs),
      }
    );
  } catch (error) {
    throw new LoreApiRequestError({
      detail: error instanceof Error ? error.message : 'Lore request failed',
    });
  }
  const boundedText = await readResponseTextBounded(response, LORE_RESPONSE_MAX_BYTES);
  if (!response.ok) {
    throwLoreResponseError(response, boundedText);
  }
  if (boundedText.truncated) {
    throw new Error('Lore response exceeded the byte limit.');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(boundedText.text);
  } catch {
    throw new Error('Lore ingest response was not valid JSON.');
  }
  const address = (payload as { data?: { address?: unknown } } | null)?.data?.address;
  if (typeof address !== 'string') {
    throw new Error('Lore ingest response missing data.address.');
  }
  validateAddress(address);
  return address;
}

export async function putBackstageBytesToLore(input: {
  config: ConfiguredLoreBackstageConfig;
  repositoryId: string;
  bytes: ArrayBuffer | Uint8Array;
}): Promise<{ address: string; sha256: string; byteSize: number }> {
  validateRepositoryId(input.repositoryId);
  const bytes = asOwnedBytes(input.bytes);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = toHex(new Uint8Array(digest));
  const address = await putBackstageBodyToLoreRequest({
    config: input.config,
    repositoryId: input.repositoryId,
    body: bytes,
  });
  return { address, sha256, byteSize: bytes.byteLength };
}

export async function putBackstageBodyToLore(input: {
  config: ConfiguredLoreBackstageConfig;
  repositoryId: string;
  body: BodyInit;
  sha256: string;
  byteSize: number;
}): Promise<{ address: string; sha256: string; byteSize: number }> {
  validateRepositoryId(input.repositoryId);
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw new Error('Lore body sha256 must be exactly 64 lowercase hexadecimal characters.');
  }
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 0) {
    throw new Error('Lore body byteSize must be a non-negative safe integer.');
  }
  const address = await putBackstageBodyToLoreRequest(input);
  return { address, sha256: input.sha256, byteSize: input.byteSize };
}

export async function getBackstageBytesFromLore(input: {
  config: ConfiguredLoreBackstageConfig;
  repositoryId: string;
  address: string;
}): Promise<ArrayBuffer> {
  validateRepositoryId(input.repositoryId);
  validateAddress(input.address);

  let response: Response;
  try {
    response = await fetch(
      `${input.config.apiBaseUrl}/v1/repository/${input.repositoryId}/content/${input.address}`,
      {
        headers: accessHeaders(input.config),
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(input.config.timeoutMs),
      }
    );
  } catch (error) {
    throw new LoreApiRequestError({
      detail: error instanceof Error ? error.message : 'Lore request failed',
    });
  }

  if (!response.ok) {
    throwLoreResponseError(
      response,
      await readResponseTextBounded(response, LORE_RESPONSE_MAX_BYTES)
    );
  }
  return await response.arrayBuffer();
}

export async function mintLorePresignedUrl(input: {
  config: ConfiguredLoreBackstageConfig;
  repositoryId: string;
  address: string;
  ttlSeconds?: number;
  contentType?: string;
  contentDisposition?: string;
}): Promise<{ url: string; expiresAt: number }> {
  validateRepositoryId(input.repositoryId);
  validateAddress(input.address);
  const ttlSeconds = input.ttlSeconds ?? input.config.defaultTtlSeconds;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('Lore presign TTL must be a positive integer number of seconds.');
  }

  const presignHmacKey = requireNonEmpty(input.config.presignHmacKey, 'LORE_PRESIGN_HMAC_KEY');
  const keyBytes = hexDecode(presignHmacKey, 'LORE_PRESIGN_HMAC_KEY');
  if (keyBytes.byteLength < 32) {
    throw new Error('LORE_PRESIGN_HMAC_KEY must decode to at least 32 bytes.');
  }
  const keyId = toHex(blake3(keyBytes)).slice(0, 16);
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = {
    version: 1,
    key_id: keyId,
    repository: input.repositoryId,
    address: input.address,
    expires_at: expiresAt,
    ...(input.contentType ? { content_type: input.contentType } : {}),
    ...(input.contentDisposition ? { content_disposition: input.contentDisposition } : {}),
  };
  const encodedPayload = base64UrlNoPad(new TextEncoder().encode(JSON.stringify(payload)));
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    new TextEncoder().encode(encodedPayload)
  );
  const token = `${encodedPayload}.${base64UrlNoPad(new Uint8Array(signature))}`;
  return {
    url: `${input.config.apiBaseUrl}/v1/presigned/${input.repositoryId}/${input.address}?token=${token}`,
    expiresAt,
  };
}
