import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import type { ExtractedForensicsAsset } from './couplingForensicsArchives';

export type CouplingForensicsServiceConfig = {
  baseUrl: string;
  sharedSecret: string;
  attributionTimeoutMs?: number;
};

export type CouplingForensicsFinding = {
  assetPath: string;
  assetType: 'png' | 'fbx';
  decoderKind: string;
  tokenHex: string;
  tokenLength: number;
};

export type ForensicPreclassification = 'decoded' | 'likely-stripped' | 'no-signal';

export type ForensicsScoreResult = {
  assetPath: string;
  assetType: 'png' | 'fbx';
  decoderKind: string;
  preclassification: ForensicPreclassification;
  tokenHex?: string;
  tokenLength?: number;
  matchedLicenseSubject?: string;
  nativeCode?: number;
  decodeError?: string;
};

type CouplingServiceResponse = {
  error?:
    | string
    | {
        code?: unknown;
        message?: unknown;
      };
  results?: Array<{
    assetPath?: string;
    assetType?: string;
    decoderKind?: string;
    tokenHex?: string;
    tokenLength?: number;
  }>;
};

type ForensicScoreServiceResponse = {
  error?:
    | string
    | {
        code?: unknown;
        message?: unknown;
      };
  requestId?: string;
  results?: Array<{
    assetPath?: string;
    assetType?: string;
    decoderKind?: string;
    preclassification?: string;
    tokenHex?: string;
    tokenLength?: number;
    nativeCode?: number;
    decodeError?: string;
  }>;
};

const HEX_RE = /^[0-9a-f]+$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const ATTRIBUTION_REQUEST_TIMEOUT_MS = 15_000;
const METADATA_SERVICE_HOSTS = new Set([
  '169.254.169.254',
  'fd00:ec2::254',
  'metadata.google.internal',
  'metadata.azure.internal',
]);

export class CouplingServiceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CouplingServiceConfigurationError';
  }
}

export class CouplingServiceRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'CouplingServiceRequestError';
  }
}

function normalizeAssetType(value: string): 'png' | 'fbx' {
  const normalized = value.trim().toLowerCase();
  if (normalized !== 'png' && normalized !== 'fbx') {
    throw new CouplingServiceRequestError(`Unsupported coupling scan asset type: ${value}`, 502);
  }
  return normalized;
}

function buildAssetMapByPath(
  input: ExtractedForensicsAsset[],
  duplicateContext: string
): Map<string, ExtractedForensicsAsset> {
  const assetByPath = new Map<string, ExtractedForensicsAsset>();
  for (const entry of input) {
    if (assetByPath.has(entry.assetPath)) {
      throw new CouplingServiceRequestError(
        `Duplicate asset path in ${duplicateContext}: ${entry.assetPath}`,
        502
      );
    }
    assetByPath.set(entry.assetPath, entry);
  }
  return assetByPath;
}

function buildCouplingServiceUrl(baseUrl: string, path: string): string {
  const normalizedBaseUrl = baseUrl.trim();
  if (!normalizedBaseUrl) {
    throw new CouplingServiceConfigurationError('Coupling service base URL is not configured');
  }
  const url = new URL(path, `${normalizedBaseUrl.replace(/\/$/, '')}/`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CouplingServiceConfigurationError('Coupling service base URL must use http or https');
  }
  if (url.username || url.password) {
    throw new CouplingServiceConfigurationError(
      'Coupling service base URL must not include credentials'
    );
  }
  assertAllowedCouplingServiceHost(url);
  return url.toString();
}

function assertAllowedCouplingServiceHost(url: URL): void {
  const hostname = normalizeUrlHostname(url.hostname);
  const mappedIpv4Hostname = parseIpv4MappedIpv6Hostname(hostname);
  if (
    isDeniedMetadataHostname(hostname) ||
    (mappedIpv4Hostname && isDeniedMetadataHostname(mappedIpv4Hostname))
  ) {
    throw new CouplingServiceConfigurationError('Coupling service base URL host is not allowed');
  }

  if (isIP(hostname) && isLinkLocalIp(mappedIpv4Hostname ?? hostname)) {
    throw new CouplingServiceConfigurationError('Coupling service base URL host is not allowed');
  }
}

function isDeniedMetadataHostname(hostname: string): boolean {
  return METADATA_SERVICE_HOSTS.has(hostname) || hostname === '100.100.100.200';
}

function normalizeUrlHostname(hostname: string): string {
  let normalized = hostname.toLowerCase();
  while (normalized.endsWith('.')) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function parseIpv4MappedIpv6Hostname(hostname: string): string | null {
  if (!hostname.startsWith('::ffff:')) {
    return null;
  }

  const suffix = hostname.slice('::ffff:'.length);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(suffix)) {
    return suffix;
  }

  const hextets = suffix.split(':');
  if (hextets.length !== 2) {
    return null;
  }
  const parsed = hextets.map((hextet) => Number.parseInt(hextet, 16));
  if (
    parsed.some(
      (value, index) =>
        !/^[0-9a-f]{1,4}$/.test(hextets[index] ?? '') || !Number.isFinite(value) || value < 0
    )
  ) {
    return null;
  }

  return [
    (parsed[0] ?? 0) >> 8,
    (parsed[0] ?? 0) & 0xff,
    (parsed[1] ?? 0) >> 8,
    (parsed[1] ?? 0) & 0xff,
  ].join('.');
}

function isLinkLocalIp(hostname: string): boolean {
  if (hostname.startsWith('169.254.')) {
    return true;
  }
  return hostname === '::ffff:169.254.169.254' || hostname.toLowerCase().startsWith('fe80:');
}

function buildCouplingScanUrl(baseUrl: string): string {
  return buildCouplingServiceUrl(baseUrl, 'v1/coupling/scan');
}

function validateCouplingScanResult(
  input: ExtractedForensicsAsset[],
  payload: CouplingServiceResponse
): CouplingForensicsFinding[] {
  const assetByPath = new Map(input.map((entry) => [entry.assetPath, entry]));
  const results = payload.results ?? [];
  return results.map((entry) => {
    const assetPath = entry.assetPath?.trim() || '';
    const tokenHex = entry.tokenHex?.trim().toLowerCase() || '';
    const tokenLength = Number(entry.tokenLength ?? 0);
    const inputEntry = assetByPath.get(assetPath);
    if (!inputEntry) {
      throw new CouplingServiceRequestError('Coupling service returned an unknown asset path', 502);
    }
    if (!tokenHex || !HEX_RE.test(tokenHex)) {
      throw new CouplingServiceRequestError('Coupling service returned an invalid token', 502);
    }
    if (tokenLength <= 0 || tokenHex.length !== tokenLength) {
      throw new CouplingServiceRequestError('Coupling service token length mismatch', 502);
    }
    return {
      assetPath,
      assetType: normalizeAssetType(entry.assetType || inputEntry.assetType),
      decoderKind: entry.decoderKind?.trim() || inputEntry.assetType,
      tokenHex,
      tokenLength,
    };
  });
}

async function buildRequestBody(assets: ExtractedForensicsAsset[]): Promise<string> {
  const serializedAssets = await Promise.all(
    assets.map(async (asset) => ({
      assetPath: asset.assetPath,
      assetType: asset.assetType,
      contentBase64: Buffer.from(await readFile(asset.filePath)).toString('base64'),
    }))
  );

  return JSON.stringify({
    mode: 'scan',
    assets: serializedAssets,
  });
}

function parseResponsePayload(responseText: string): CouplingServiceResponse | null {
  if (!responseText.trim()) {
    return {};
  }

  try {
    return JSON.parse(responseText) as CouplingServiceResponse;
  } catch {
    return null;
  }
}

function extractCouplingServiceErrorDetail(
  payload:
    | {
        error?:
          | string
          | {
              code?: unknown;
              message?: unknown;
            };
      }
    | null
    | undefined,
  responseText: string,
  statusText: string
): string {
  const rawError = payload?.error;
  if (typeof rawError === 'string') {
    return rawError.trim() || responseText.trim() || statusText.trim();
  }
  if (rawError && typeof rawError === 'object') {
    const message = typeof rawError.message === 'string' ? rawError.message.trim() : '';
    if (message) {
      return message;
    }
    const code = typeof rawError.code === 'string' ? rawError.code.trim() : '';
    if (code) {
      return code;
    }
  }
  return responseText.trim() || statusText.trim();
}

function buildForensicScoreUrl(baseUrl: string): string {
  return buildCouplingServiceUrl(baseUrl, 'v1/coupling/forensic-score');
}

function validateForensicsScoreResult(
  input: ExtractedForensicsAsset[],
  payload: ForensicScoreServiceResponse
): ForensicsScoreResult[] {
  const assetByPath = new Map(input.map((entry) => [entry.assetPath, entry]));
  const results = payload.results ?? [];
  const validatedResults = new Map<string, ForensicsScoreResult>();

  for (const entry of results) {
    const assetPath = entry.assetPath?.trim() || '';
    const inputEntry = assetByPath.get(assetPath);
    if (!inputEntry) {
      throw new CouplingServiceRequestError('Coupling service returned an unknown asset path', 502);
    }
    if (validatedResults.has(assetPath)) {
      throw new CouplingServiceRequestError(
        'Coupling service returned a duplicate asset path',
        502
      );
    }

    const preclassificationRaw = entry.preclassification?.trim() ?? '';
    const preclassification: ForensicPreclassification =
      preclassificationRaw === 'decoded' ||
      preclassificationRaw === 'likely-stripped' ||
      preclassificationRaw === 'no-signal'
        ? (preclassificationRaw as ForensicPreclassification)
        : 'no-signal';

    const result: ForensicsScoreResult = {
      assetPath,
      assetType: normalizeAssetType(entry.assetType || inputEntry.assetType),
      decoderKind: entry.decoderKind?.trim() || inputEntry.assetType,
      preclassification,
    };

    if (preclassification === 'decoded' && entry.tokenHex) {
      const tokenHex = entry.tokenHex.trim().toLowerCase();
      const tokenLength = Number(entry.tokenLength ?? 0);
      if (HEX_RE.test(tokenHex) && tokenLength > 0 && tokenHex.length === tokenLength) {
        result.tokenHex = tokenHex;
        result.tokenLength = tokenLength;
      }
    }

    if (entry.nativeCode !== undefined) {
      result.nativeCode = entry.nativeCode;
    }

    if (entry.decodeError) {
      result.decodeError = entry.decodeError.trim();
    }

    validatedResults.set(assetPath, result);
  }

  return input.map((asset) => {
    const existing = validatedResults.get(asset.assetPath);
    if (existing) {
      return existing;
    }
    return {
      assetPath: asset.assetPath,
      assetType: asset.assetType,
      decoderKind: asset.assetType,
      preclassification: 'no-signal',
    };
  });
}

export async function runCouplingForensicsScore(
  assets: ExtractedForensicsAsset[],
  config: CouplingForensicsServiceConfig
): Promise<ForensicsScoreResult[]> {
  if (assets.length === 0) {
    return [];
  }

  const sharedSecret = config.sharedSecret.trim();
  if (!sharedSecret) {
    throw new CouplingServiceConfigurationError('Coupling service shared secret is not configured');
  }

  let response: Response;
  try {
    response = await fetch(buildForensicScoreUrl(config.baseUrl), {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${sharedSecret}`,
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      },
      body: await buildRequestBody(assets),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CouplingServiceRequestError(`Coupling service is unreachable: ${message}`, 503);
  }

  const responseText = await response.text();
  const payload = parseResponsePayload(responseText) as ForensicScoreServiceResponse | null;

  if (!response.ok) {
    const detail = extractCouplingServiceErrorDetail(payload, responseText, response.statusText);
    throw new CouplingServiceRequestError(
      `Coupling forensic-score failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status
    );
  }

  if (!payload) {
    throw new CouplingServiceRequestError(
      'Coupling service returned invalid JSON',
      response.status
    );
  }

  return validateForensicsScoreResult(assets, payload);
}

export type CouplingAttributionCandidate = {
  assetPath: string;
  licenseSubject: string;
  tokenHash: string;
};

type AttributeServiceResponse = {
  error?:
    | string
    | {
        code?: unknown;
        message?: unknown;
      };
  requestId?: string;
  results?: Array<{
    assetPath?: string;
    assetType?: string;
    matched?: boolean;
    tokenHex?: string;
    matchedLicenseSubject?: string;
    wmVersion?: number;
    attempted?: number;
  }>;
};

function buildAttributeUrl(baseUrl: string): string {
  return buildCouplingServiceUrl(baseUrl, 'v1/coupling/attribute');
}

function resolveAttributionTimeoutMs(config: CouplingForensicsServiceConfig): number {
  const configured = config.attributionTimeoutMs;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return ATTRIBUTION_REQUEST_TIMEOUT_MS;
}

async function buildAttributeRequestBody(
  assets: ExtractedForensicsAsset[],
  candidates: CouplingAttributionCandidate[]
): Promise<string> {
  const serializedAssets = await Promise.all(
    assets.map(async (asset) => ({
      assetPath: asset.assetPath,
      assetType: asset.assetType,
      contentBase64: Buffer.from(await readFile(asset.filePath)).toString('base64'),
    }))
  );

  return JSON.stringify({
    assets: serializedAssets,
    candidates: candidates.map((candidate) => ({
      assetPath: candidate.assetPath,
      licenseSubject: candidate.licenseSubject,
      tokenHash: candidate.tokenHash,
    })),
  });
}

function validateAttributionResult(
  input: ExtractedForensicsAsset[],
  payload: AttributeServiceResponse
): ForensicsScoreResult[] {
  const assetByPath = buildAssetMapByPath(input, 'attribution input');
  const results = payload.results ?? [];
  const validatedResults = new Map<string, ForensicsScoreResult>();

  for (const entry of results) {
    const assetPath = entry.assetPath?.trim() || '';
    const inputEntry = assetByPath.get(assetPath);
    if (!inputEntry) {
      throw new CouplingServiceRequestError('Coupling service returned an unknown asset path', 502);
    }
    if (validatedResults.has(assetPath)) {
      throw new CouplingServiceRequestError(
        'Coupling service returned a duplicate asset path',
        502
      );
    }

    const assetType = normalizeAssetType(entry.assetType || inputEntry.assetType);
    // Seed-iteration attribution decodes only when a candidate's re-derived seed matches, so a
    // matched asset is a recovered trace ('decoded'); anything else carries no usable signal.
    if (entry.matched === true && entry.tokenHex) {
      const tokenHex = entry.tokenHex.trim().toLowerCase();
      if (HEX_RE.test(tokenHex) && tokenHex.length > 0) {
        const matchedLicenseSubject = entry.matchedLicenseSubject?.trim().toLowerCase() || '';
        if (!SHA256_HEX_RE.test(matchedLicenseSubject)) {
          throw new CouplingServiceRequestError(
            'Coupling service returned an invalid matched license subject',
            502
          );
        }
        validatedResults.set(assetPath, {
          assetPath,
          assetType,
          decoderKind: assetType,
          preclassification: 'decoded',
          tokenHex,
          tokenLength: tokenHex.length,
          matchedLicenseSubject,
        });
        continue;
      }
    }

    validatedResults.set(assetPath, {
      assetPath,
      assetType,
      decoderKind: assetType,
      preclassification: 'no-signal',
    });
  }

  return input.map((asset) => {
    const existing = validatedResults.get(asset.assetPath);
    if (existing) {
      return existing;
    }
    return {
      assetPath: asset.assetPath,
      assetType: asset.assetType,
      decoderKind: asset.assetType,
      preclassification: 'no-signal',
    };
  });
}

/**
 * Forensic attribution: ask the closed coupling service to decode each leaked asset by iterating
 * the supplied buyer candidates (it re-derives each per-job placement seed from the recorded
 * assetPath + licenseSubject). A matched asset comes back as a recovered trace with its token and
 * matched subject; the caller turns that into an exact candidate lookup for identity enrichment.
 * No watermark secrets leave the service; only candidate (assetPath, licenseSubject, tokenHash)
 * tuples go in.
 */
export async function runCouplingAttribution(
  assets: ExtractedForensicsAsset[],
  candidates: CouplingAttributionCandidate[],
  config: CouplingForensicsServiceConfig
): Promise<ForensicsScoreResult[]> {
  if (assets.length === 0) {
    return [];
  }
  if (candidates.length === 0) {
    return assets.map((asset) => ({
      assetPath: asset.assetPath,
      assetType: asset.assetType,
      decoderKind: asset.assetType,
      preclassification: 'no-signal',
    }));
  }
  buildAssetMapByPath(assets, 'attribution input');

  const sharedSecret = config.sharedSecret.trim();
  if (!sharedSecret) {
    throw new CouplingServiceConfigurationError('Coupling service shared secret is not configured');
  }

  let response: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), resolveAttributionTimeoutMs(config));
    try {
      response = await fetch(buildAttributeUrl(config.baseUrl), {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${sharedSecret}`,
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json',
        },
        body: await buildAttributeRequestBody(assets, candidates),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new CouplingServiceRequestError('Coupling attribution timed out', 504);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (
      error instanceof CouplingServiceRequestError ||
      error instanceof CouplingServiceConfigurationError
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new CouplingServiceRequestError(`Coupling service is unreachable: ${message}`, 503);
  }

  const responseText = await response.text();
  const payload = parseResponsePayload(responseText) as AttributeServiceResponse | null;

  if (!response.ok) {
    const detail = extractCouplingServiceErrorDetail(payload, responseText, response.statusText);
    throw new CouplingServiceRequestError(
      `Coupling attribution failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status
    );
  }

  if (!payload) {
    throw new CouplingServiceRequestError(
      'Coupling service returned invalid JSON',
      response.status
    );
  }

  return validateAttributionResult(assets, payload);
}

export async function runCouplingForensicsScan(
  assets: ExtractedForensicsAsset[],
  config: CouplingForensicsServiceConfig
): Promise<CouplingForensicsFinding[]> {
  if (assets.length === 0) {
    return [];
  }

  const sharedSecret = config.sharedSecret.trim();
  if (!sharedSecret) {
    throw new CouplingServiceConfigurationError('Coupling service shared secret is not configured');
  }

  let response: Response;
  try {
    response = await fetch(buildCouplingScanUrl(config.baseUrl), {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${sharedSecret}`,
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      },
      body: await buildRequestBody(assets),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CouplingServiceRequestError(`Coupling service is unreachable: ${message}`, 503);
  }

  const responseText = await response.text();
  const payload = parseResponsePayload(responseText);

  if (!response.ok) {
    const detail = extractCouplingServiceErrorDetail(payload, responseText, response.statusText);
    throw new CouplingServiceRequestError(
      `Coupling service scan failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status
    );
  }

  if (!payload) {
    throw new CouplingServiceRequestError(
      'Coupling service returned invalid JSON',
      response.status
    );
  }

  return validateCouplingScanResult(assets, payload);
}
