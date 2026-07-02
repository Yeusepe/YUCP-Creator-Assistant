/**
 * Coupling runtime gateway.
 *
 * The coupling-runtime DLL lives in git and is served by the PRIVATE coupling service. It is never
 * stored in Convex. Only the API is in-network with that private service, so the API owns the two
 * importer-facing routes and Convex keeps just the control-plane crypto/bookkeeping:
 *
 *   POST /v1/licenses/coupling-job
 *     API -> Convex verifyCouplingJobLicense: verify the machine-bound license
 *     API -> coupling service: fetch the git-served runtime manifest + derive placement seeds
 *     API -> Convex assembleCouplingJob: re-verify license, mint tokens, record traces, sign the
 *            full-manifest runtime download token
 *
 *   GET /v1/licenses/coupling-runtime?token=...
 *     API -> coupling service: proxy the DLL download (the service validates the runtime token and
 *            serves the bytes from git)
 *
 * Registered ahead of the Convex proxy so these paths never fall through to Convex.
 */

import { api } from '../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../lib/convex';
import { logger } from '../lib/logger';
import { RequestBodyError, readJsonObjectBodyWithLimit } from '../lib/requestBody';

const REQUEST_TIMEOUT_MS = 15_000;
const MANIFEST_RESPONSE_MAX_BYTES = 64 * 1024;
const SEEDS_RESPONSE_MAX_BYTES = 512 * 1024;
export const COUPLING_JOB_BODY_MAX_BYTES = 128 * 1024;
const COUPLING_ASSET_PATH_MAX_LENGTH = 512;
export const MAX_COUPLING_ASSET_PATHS = 100;
export const RUNTIME_DOWNLOAD_MAX_BYTES = 128 * 1024 * 1024;
const RUNTIME_ARTIFACT_KEY = 'coupling-runtime';
const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const PROJECT_ID_RE = /^[a-f0-9]{32}$/;
const MACHINE_FINGERPRINT_RE = /^[a-z0-9:_-]{16,256}$/i;
const LICENSE_TOKEN_MAX_LENGTH = 8192;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const RUNTIME_VERSION_RE = /^[a-z0-9._:-]{1,128}$/i;
const RUNTIME_DELIVERY_NAME_RE = /^[a-z0-9._-]{1,128}$/i;

export interface CouplingRuntimeGatewayConfig {
  convexUrl: string;
  convexApiSecret: string;
  couplingServiceBaseUrl?: string;
  couplingServiceSharedSecret?: string;
}

type RuntimeManifest = {
  artifactKey: string;
  channel: string;
  platform: string;
  version: string;
  metadataVersion: number;
  deliveryName: string;
  contentType: string;
  envelopeCipher: string;
  envelopeIvBase64: string;
  ciphertextSha256: string;
  ciphertextSize: number;
  plaintextSha256: string;
  plaintextSize: number;
  codeSigningSubject?: string;
  codeSigningThumbprint?: string;
};

type CouplingLicenseVerificationActionResult =
  | { success: true; licenseSubject: string; error?: undefined }
  | { success: false; licenseSubject?: undefined; error?: string };

type CouplingLicensePreflightResult =
  | { success: true; licenseSubject: string }
  | { success: false; response: Response };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** Skip coupling without failing the install (the importer treats empty files as a no-op). */
function skipResponse(skipReason: string): Response {
  return jsonResponse({ success: true, files: [], skipReason });
}

/** Trusted operator-configured base URL; reject anything that isn't https or explicit loopback. */
function resolveServiceEndpoint(baseUrl: string, path: string): URL | null {
  let endpoint: URL;
  try {
    endpoint = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  } catch {
    return null;
  }
  if (endpoint.username || endpoint.password) {
    return null;
  }
  if (endpoint.protocol === 'https:') {
    return endpoint;
  }
  const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (endpoint.protocol === 'http:' && loopback.has(endpoint.hostname)) {
    return endpoint;
  }
  return null;
}

function readRequiredString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function readRequiredNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPositiveSafeInteger(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

function isValidMetadataVersion(value: number | null): value is number {
  return isPositiveSafeInteger(value) && value <= 10_000;
}

function isValidRuntimeSize(value: number | null): value is number {
  return isPositiveSafeInteger(value) && value <= RUNTIME_DOWNLOAD_MAX_BYTES;
}

function isValidOptionalManifestString(value: unknown): value is string | undefined {
  return (
    value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 256)
  );
}

function parseRuntimeManifest(payload: unknown): RuntimeManifest | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const data = payload as Record<string, unknown>;
  const artifactKey = readRequiredString(data, 'artifactKey');
  const channel = readRequiredString(data, 'channel');
  const platform = readRequiredString(data, 'platform');
  const version = readRequiredString(data, 'version');
  const metadataVersion = readRequiredNumber(data, 'metadataVersion');
  const deliveryName = readRequiredString(data, 'deliveryName');
  const contentType = readRequiredString(data, 'contentType');
  const envelopeCipher = readRequiredString(data, 'envelopeCipher');
  const envelopeIvBase64 = readString(data, 'envelopeIvBase64');
  const ciphertextSha256 = readRequiredString(data, 'ciphertextSha256');
  const ciphertextSize = readRequiredNumber(data, 'ciphertextSize');
  const plaintextSha256 = readRequiredString(data, 'plaintextSha256');
  const plaintextSize = readRequiredNumber(data, 'plaintextSize');
  const codeSigningSubject = data.codeSigningSubject;
  const codeSigningThumbprint = data.codeSigningThumbprint;

  if (
    data.success !== true ||
    artifactKey !== RUNTIME_ARTIFACT_KEY ||
    channel !== 'stable' ||
    platform !== 'win-x64' ||
    !version ||
    !RUNTIME_VERSION_RE.test(version) ||
    !isValidMetadataVersion(metadataVersion) ||
    !deliveryName ||
    !RUNTIME_DELIVERY_NAME_RE.test(deliveryName) ||
    contentType !== 'application/octet-stream' ||
    envelopeCipher !== 'none' ||
    envelopeIvBase64 === null ||
    envelopeIvBase64 !== '' ||
    !ciphertextSha256 ||
    !SHA256_HEX_RE.test(ciphertextSha256) ||
    !isValidRuntimeSize(ciphertextSize) ||
    !plaintextSha256 ||
    !SHA256_HEX_RE.test(plaintextSha256) ||
    !isValidRuntimeSize(plaintextSize) ||
    ciphertextSha256.toLowerCase() !== plaintextSha256.toLowerCase() ||
    ciphertextSize !== plaintextSize ||
    !isValidOptionalManifestString(codeSigningSubject) ||
    !isValidOptionalManifestString(codeSigningThumbprint)
  ) {
    return null;
  }

  const manifest: RuntimeManifest = {
    artifactKey,
    channel,
    platform,
    version,
    metadataVersion,
    deliveryName,
    contentType,
    envelopeCipher,
    envelopeIvBase64,
    ciphertextSha256,
    ciphertextSize,
    plaintextSha256,
    plaintextSize,
  };

  if (codeSigningSubject !== undefined) {
    manifest.codeSigningSubject = codeSigningSubject;
  }
  if (codeSigningThumbprint !== undefined) {
    manifest.codeSigningThumbprint = codeSigningThumbprint;
  }

  return manifest;
}

function isValidCouplingAssetPath(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= COUPLING_ASSET_PATH_MAX_LENGTH
  );
}

function readContentLength(headers: Headers): number | null {
  const raw = headers.get('content-length');
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchRuntimeManifest(
  config: CouplingRuntimeGatewayConfig
): Promise<RuntimeManifest | null> {
  const endpoint = resolveServiceEndpoint(
    config.couplingServiceBaseUrl ?? '',
    `v1/runtime-artifacts/manifest?artifactKey=${encodeURIComponent(RUNTIME_ARTIFACT_KEY)}`
  );
  if (!endpoint) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint.toString(), {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.couplingServiceSharedSecret}`,
        'Cache-Control': 'no-store',
      },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const text = await readBoundedText(res, MANIFEST_RESPONSE_MAX_BYTES);
    if (!text) return null;
    return parseRuntimeManifest(JSON.parse(text));
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function deriveSeeds(
  config: CouplingRuntimeGatewayConfig,
  licenseSubject: string,
  assetPaths: string[]
): Promise<{ assetPath: string; seedHex: string }[] | null> {
  const endpoint = resolveServiceEndpoint(
    config.couplingServiceBaseUrl ?? '',
    'v1/coupling/internal/derive-seeds'
  );
  if (!endpoint) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.couplingServiceSharedSecret}`,
      },
      body: JSON.stringify({ licenseSubject, assetPaths }),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const text = await readBoundedText(res, SEEDS_RESPONSE_MAX_BYTES);
    if (!text) return null;
    const data = JSON.parse(text) as { seeds?: { assetPath?: unknown; seedHex?: unknown }[] };
    if (!Array.isArray(data?.seeds)) return null;
    const seeds: { assetPath: string; seedHex: string }[] = [];
    for (const seed of data.seeds) {
      if (
        typeof seed?.assetPath === 'string' &&
        typeof seed?.seedHex === 'string' &&
        /^[0-9a-f]{64}$/i.test(seed.seedHex)
      ) {
        seeds.push({ assetPath: seed.assetPath, seedHex: seed.seedHex.toLowerCase() });
      }
    }
    return seeds;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyCouplingJobLicense(
  config: CouplingRuntimeGatewayConfig,
  packageId: string,
  machineFingerprint: string,
  licenseToken: string
): Promise<CouplingLicensePreflightResult> {
  try {
    const convex = getConvexClientFromUrl(config.convexUrl);
    const result = (await convex.action(api.yucpLicenses.verifyCouplingJobLicense, {
      apiSecret: config.convexApiSecret,
      packageId,
      machineFingerprint,
      licenseToken,
    })) as CouplingLicenseVerificationActionResult;

    if (!result.success) {
      return {
        success: false,
        response: jsonResponse({ error: result.error ?? 'License verification failed' }, 422),
      };
    }
    if (!result.licenseSubject) {
      logger.error('coupling-job license verification returned no subject');
      return {
        success: false,
        response: jsonResponse({ error: 'License verification failed' }, 502),
      };
    }
    return { success: true, licenseSubject: result.licenseSubject };
  } catch (error) {
    logger.error('coupling-job license verification failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      response: jsonResponse({ error: 'Failed to verify coupling license' }, 502),
    };
  }
}

function createBoundedRuntimeDownloadStream(
  body: ReadableStream<Uint8Array> | null,
  abortController: AbortController
): ReadableStream<Uint8Array> | null {
  if (!body) return null;

  const reader = body.getReader();
  let bytesRead = 0;
  let released = false;
  let idleTimeout: ReturnType<typeof setTimeout> | null = null;

  const clearIdleTimeout = () => {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
      idleTimeout = null;
    }
  };
  const resetIdleTimeout = () => {
    clearIdleTimeout();
    idleTimeout = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);
  };
  const releaseReader = () => {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        resetIdleTimeout();
        const { done, value } = await reader.read();
        clearIdleTimeout();
        if (done) {
          releaseReader();
          controller.close();
          return;
        }
        bytesRead += value.byteLength;
        if (bytesRead > RUNTIME_DOWNLOAD_MAX_BYTES) {
          abortController.abort();
          await reader.cancel().catch(() => undefined);
          releaseReader();
          controller.error(new Error('Coupling runtime download exceeded size limit'));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        clearIdleTimeout();
        releaseReader();
        controller.error(error);
      }
    },
    async cancel(reason) {
      clearIdleTimeout();
      abortController.abort();
      await reader.cancel(reason).catch(() => undefined);
      releaseReader();
    },
  });
}

async function handleCouplingJob(
  request: Request,
  config: CouplingRuntimeGatewayConfig
): Promise<Response> {
  let body: {
    packageId?: unknown;
    projectId?: unknown;
    machineFingerprint?: unknown;
    licenseToken?: unknown;
    assetPaths?: unknown;
  };
  try {
    body = await readJsonObjectBodyWithLimit(request, COUPLING_JOB_BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return jsonResponse({ error: error.message }, error.status);
    }
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const packageId = typeof body.packageId === 'string' ? body.packageId : '';
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  const machineFingerprint =
    typeof body.machineFingerprint === 'string' ? body.machineFingerprint : '';
  const licenseToken = typeof body.licenseToken === 'string' ? body.licenseToken : '';
  const assetPaths = Array.isArray(body.assetPaths) ? body.assetPaths : null;

  if (!packageId || !projectId || !machineFingerprint || !licenseToken) {
    return jsonResponse(
      { error: 'packageId, projectId, machineFingerprint, and licenseToken are required' },
      400
    );
  }
  if (!PACKAGE_ID_RE.test(packageId)) {
    return jsonResponse({ error: 'Invalid packageId format' }, 400);
  }
  if (!PROJECT_ID_RE.test(projectId)) {
    return jsonResponse({ error: 'Invalid projectId format' }, 400);
  }
  if (!MACHINE_FINGERPRINT_RE.test(machineFingerprint)) {
    return jsonResponse({ error: 'Invalid machineFingerprint format' }, 400);
  }
  if (licenseToken.length > LICENSE_TOKEN_MAX_LENGTH) {
    return jsonResponse({ error: 'Invalid licenseToken format' }, 400);
  }
  if (!assetPaths) {
    return jsonResponse({ error: 'assetPaths must be an array' }, 400);
  }
  if (assetPaths.length > MAX_COUPLING_ASSET_PATHS) {
    return jsonResponse({ error: 'Too many coupling asset paths' }, 400);
  }
  if (!assetPaths.every(isValidCouplingAssetPath)) {
    return jsonResponse({ error: 'Invalid coupling asset path' }, 400);
  }
  if (assetPaths.length === 0) {
    return skipResponse('no_assets');
  }

  // Coupling is best-effort: if the private service isn't wired up, skip rather than fail the import.
  if (!config.couplingServiceBaseUrl || !config.couplingServiceSharedSecret) {
    return skipResponse('no_runtime');
  }

  const verifiedLicense = await verifyCouplingJobLicense(
    config,
    packageId,
    machineFingerprint,
    licenseToken
  );
  if (!verifiedLicense.success) {
    return verifiedLicense.response;
  }

  const manifest = await fetchRuntimeManifest(config);
  if (!manifest) {
    return skipResponse('no_runtime');
  }

  const seeds = await deriveSeeds(config, verifiedLicense.licenseSubject, assetPaths);
  if (!seeds || seeds.length === 0) {
    return skipResponse('seed_unavailable');
  }

  try {
    const convex = getConvexClientFromUrl(config.convexUrl);
    const result = await convex.action(api.yucpLicenses.assembleCouplingJob, {
      apiSecret: config.convexApiSecret,
      packageId,
      projectId,
      machineFingerprint,
      licenseToken,
      assetPaths,
      runtimeManifest: manifest,
      seeds,
    });

    if (!result.success) {
      return jsonResponse({ error: result.error }, 422);
    }
    return jsonResponse({
      success: true,
      runtimeToken: result.runtimeToken,
      runtimeSha256: result.runtimeSha256,
      expiresAt: result.expiresAt,
      skipReason: result.skipReason,
      files: result.files ?? [],
    });
  } catch (error) {
    logger.error('coupling-job assemble failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ error: 'Failed to assemble coupling job' }, 502);
  }
}

async function handleCouplingRuntimeDownload(
  url: URL,
  config: CouplingRuntimeGatewayConfig
): Promise<Response> {
  const token = url.searchParams.get('token');
  if (!token) {
    return jsonResponse({ error: 'token is required' }, 400);
  }
  if (!config.couplingServiceBaseUrl || !config.couplingServiceSharedSecret) {
    return jsonResponse({ error: 'Coupling runtime is not available' }, 503);
  }

  const endpoint = resolveServiceEndpoint(
    config.couplingServiceBaseUrl,
    `v1/licenses/coupling-runtime?token=${encodeURIComponent(token)}`
  );
  if (!endpoint) {
    return jsonResponse({ error: 'Coupling runtime is not available' }, 503);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint.toString(), {
      headers: {
        Authorization: `Bearer ${config.couplingServiceSharedSecret}`,
        'Cache-Control': 'no-store',
      },
      redirect: 'error',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const status = res.status === 401 || res.status === 403 ? res.status : 502;
      return jsonResponse({ error: 'Coupling runtime download failed' }, status);
    }

    const contentLength = readContentLength(res.headers);
    if (contentLength !== null && contentLength > RUNTIME_DOWNLOAD_MAX_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      return jsonResponse({ error: 'Coupling runtime artifact is too large' }, 502);
    }

    // The service verifies the runtime token itself; surface its status and stream the bytes.
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const contentType = res.headers.get('content-type');
    if (contentType) headers.set('Content-Type', contentType);
    const disposition = res.headers.get('content-disposition');
    if (disposition) headers.set('Content-Disposition', disposition);
    const sha = res.headers.get('x-yucp-runtime-plaintext-sha256');
    if (sha) headers.set('X-YUCP-Runtime-Plaintext-Sha256', sha);

    const body = createBoundedRuntimeDownloadStream(res.body, controller);
    return new Response(body, { status: res.status, headers });
  } catch (error) {
    clearTimeout(timeout);
    logger.error('coupling-runtime proxy failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ error: 'Coupling runtime storage unavailable' }, 502);
  }
}

export function createCouplingRuntimeRoutes(config: CouplingRuntimeGatewayConfig): {
  handleRequest(request: Request): Promise<Response | null>;
} {
  return {
    async handleRequest(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (url.pathname === '/v1/licenses/coupling-job') {
        if (request.method !== 'POST') {
          return jsonResponse({ error: 'Method not allowed' }, 405);
        }
        return handleCouplingJob(request, config);
      }
      if (url.pathname === '/v1/licenses/coupling-runtime') {
        if (request.method !== 'GET') {
          return jsonResponse({ error: 'Method not allowed' }, 405);
        }
        return handleCouplingRuntimeDownload(url, config);
      }
      return null;
    },
  };
}
