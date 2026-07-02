/**
 * Coupling runtime gateway.
 *
 * The coupling-runtime DLL lives in git and is served by the PRIVATE coupling service. It is never
 * stored in Convex. Only the API is in-network with that private service, so the API owns the two
 * importer-facing routes and Convex keeps just the control-plane crypto/bookkeeping:
 *
 *   POST /v1/licenses/coupling-job
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

const REQUEST_TIMEOUT_MS = 15_000;
const MANIFEST_RESPONSE_MAX_BYTES = 64 * 1024;
const SEEDS_RESPONSE_MAX_BYTES = 512 * 1024;
const MAX_COUPLING_ASSET_PATHS = 100;
const RUNTIME_ARTIFACT_KEY = 'coupling-runtime';

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

/** Read a JWT `sub` without verifying (Convex re-verifies the token); used only to derive seeds. */
function decodeJwtSubject(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    return null;
  }
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as { sub?: unknown };
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

function readRequiredString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRequiredNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
  const envelopeIvBase64 = readRequiredString(data, 'envelopeIvBase64');
  const ciphertextSha256 = readRequiredString(data, 'ciphertextSha256');
  const ciphertextSize = readRequiredNumber(data, 'ciphertextSize');
  const plaintextSha256 = readRequiredString(data, 'plaintextSha256');
  const plaintextSize = readRequiredNumber(data, 'plaintextSize');

  if (
    data.success !== true ||
    artifactKey !== RUNTIME_ARTIFACT_KEY ||
    !channel ||
    !platform ||
    !version ||
    metadataVersion === null ||
    !deliveryName ||
    !contentType ||
    !envelopeCipher ||
    !envelopeIvBase64 ||
    !ciphertextSha256 ||
    ciphertextSize === null ||
    !plaintextSha256 ||
    plaintextSize === null
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

  if (data.codeSigningSubject !== undefined) {
    if (typeof data.codeSigningSubject !== 'string' || data.codeSigningSubject.length === 0) {
      return null;
    }
    manifest.codeSigningSubject = data.codeSigningSubject;
  }
  if (data.codeSigningThumbprint !== undefined) {
    if (typeof data.codeSigningThumbprint !== 'string' || data.codeSigningThumbprint.length === 0) {
      return null;
    }
    manifest.codeSigningThumbprint = data.codeSigningThumbprint;
  }

  return manifest;
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
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const packageId = typeof body.packageId === 'string' ? body.packageId : '';
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  const machineFingerprint =
    typeof body.machineFingerprint === 'string' ? body.machineFingerprint : '';
  const licenseToken = typeof body.licenseToken === 'string' ? body.licenseToken : '';
  const assetPaths = Array.isArray(body.assetPaths)
    ? body.assetPaths.filter((p): p is string => typeof p === 'string')
    : null;

  if (!packageId || !projectId || !machineFingerprint || !licenseToken) {
    return jsonResponse(
      { error: 'packageId, projectId, machineFingerprint, and licenseToken are required' },
      400
    );
  }
  if (!assetPaths) {
    return jsonResponse({ error: 'assetPaths must be an array' }, 400);
  }
  if (assetPaths.length > MAX_COUPLING_ASSET_PATHS) {
    return jsonResponse({ error: 'Too many coupling asset paths' }, 400);
  }
  if (assetPaths.length === 0) {
    return skipResponse('no_assets');
  }

  // Coupling is best-effort: if the private service isn't wired up, skip rather than fail the import.
  if (!config.couplingServiceBaseUrl || !config.couplingServiceSharedSecret) {
    return skipResponse('no_runtime');
  }

  const manifest = await fetchRuntimeManifest(config);
  if (!manifest) {
    return skipResponse('no_runtime');
  }

  const licenseSubject = decodeJwtSubject(licenseToken);
  if (!licenseSubject) {
    return jsonResponse({ error: 'License token is invalid' }, 400);
  }

  const seeds = await deriveSeeds(config, licenseSubject, assetPaths);
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

    return new Response(res.body, { status: res.status, headers });
  } catch (error) {
    logger.error('coupling-runtime proxy failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ error: 'Coupling runtime storage unavailable' }, 502);
  } finally {
    clearTimeout(timeout);
  }
}

export function createCouplingRuntimeRoutes(config: CouplingRuntimeGatewayConfig): {
  handleRequest(request: Request): Promise<Response | null>;
} {
  return {
    async handleRequest(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (url.pathname === '/v1/licenses/coupling-job' && request.method === 'POST') {
        return handleCouplingJob(request, config);
      }
      if (url.pathname === '/v1/licenses/coupling-runtime' && request.method === 'GET') {
        return handleCouplingRuntimeDownload(url, config);
      }
      return null;
    },
  };
}
