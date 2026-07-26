import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import type { ExtractedForensicsAsset } from './couplingForensicsArchives';

export type CouplingForensicsServiceConfig = {
  baseUrl: string;
  sharedSecret: string;
  requestTimeoutMs?: number;
  attributionTimeoutMs?: number;
  requestMaxBytes?: number;
  responseMaxBytes?: number;
};

export type ForensicPreclassification = 'decoded' | 'likely-stripped' | 'no-signal';

export type ForensicsScoreResult = {
  assetPath: string;
  assetType: 'png' | 'fbx';
  decoderKind: string;
  matchedAttributionId?: string;
  matchedBuyerSubjectPseudonym?: string;
  preclassification: ForensicPreclassification;
};

const ATTRIBUTION_REQUEST_TIMEOUT_MS = 15_000;
const ATTRIBUTION_REQUEST_MAX_BYTES = 24 * 1024 * 1024;
const COUPLING_SERVICE_RESPONSE_MAX_BYTES = 1024 * 1024;
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

export function buildCouplingServiceUrl(baseUrl: string, path: string): string {
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
  return hostname === '::ffff:169.254.169.254' || isIpv6LinkLocal(hostname);
}

function isIpv6LinkLocal(hostname: string): boolean {
  const firstHextet = hostname.toLowerCase().split(':', 1)[0] ?? '';
  if (!/^[0-9a-f]{1,4}$/.test(firstHextet)) {
    return false;
  }
  return (Number.parseInt(firstHextet, 16) & 0xffc0) === 0xfe80;
}

function parseResponsePayload<T>(responseText: string): T | null {
  if (!responseText.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(responseText) as T;
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

function getServiceResults<T>(payload: { results?: T[] }): T[] {
  if (payload.results === undefined) {
    return [];
  }
  if (!Array.isArray(payload.results)) {
    throw new CouplingServiceRequestError('Coupling service returned invalid results', 502);
  }
  return payload.results;
}

function resolveCouplingRequestTimeoutMs(configured?: number): number {
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return ATTRIBUTION_REQUEST_TIMEOUT_MS;
}

function resolveCouplingResponseMaxBytes(config: CouplingForensicsServiceConfig): number {
  const configured = config.responseMaxBytes;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return COUPLING_SERVICE_RESPONSE_MAX_BYTES;
}

function resolveCouplingRequestMaxBytes(config: CouplingForensicsServiceConfig): number {
  const configured = config.requestMaxBytes;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return ATTRIBUTION_REQUEST_MAX_BYTES;
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new CouplingServiceRequestError('Coupling service response is too large', 502);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchCouplingServiceResponse(
  input: string,
  init: RequestInit,
  config: CouplingForensicsServiceConfig,
  timeoutMessage: string,
  timeoutMs?: number
): Promise<{ response: Response; responseText: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolveCouplingRequestTimeoutMs(timeoutMs));
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    const responseText = await readResponseTextWithLimit(
      response,
      resolveCouplingResponseMaxBytes(config)
    );
    return { response, responseText };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new CouplingServiceRequestError(timeoutMessage, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export type CouplingAttributionCandidate = {
  algorithmVersion: string;
  attributionId: string;
  attributionTokenHash: string;
  buyerSubjectPseudonym: string;
  capabilityId: string;
  creatorId: string;
  jobId: string;
  keyEpoch: number;
  leaseGeneration: number;
  materializerType: 'fbx' | 'png' | 'zip';
  normalizedPath: string;
  outputFormat: 'zip';
  pluginVersion: string;
  protectedSourceRoot: string;
  releaseRoot: string;
  sourceSha256: string;
};

type AttributeServiceResponse = {
  error?:
    | string
    | {
        code?: unknown;
        message?: unknown;
      };
  schemaVersion?: number;
  results?: Array<{
    assetPath?: string;
    assetType?: string;
    attributionId?: string;
    buyerSubjectPseudonym?: string;
    matched?: boolean;
  }>;
};

function buildAttributeUrl(baseUrl: string): string {
  return buildCouplingServiceUrl(baseUrl, 'v2/internal/coupling/attribution/evaluate');
}

type SerializedAttributionAsset = {
  assetPath: string;
  assetType: 'png' | 'fbx';
  contentBase64: string;
};

type AttributionBatch = {
  assets: ExtractedForensicsAsset[];
  candidates: CouplingAttributionCandidate[];
  serializedAssets: SerializedAttributionAsset[];
};

function buildAttributeRequestBody(
  serializedAssets: SerializedAttributionAsset[],
  candidates: CouplingAttributionCandidate[]
): string {
  return JSON.stringify({
    assets: serializedAssets,
    candidates,
    schemaVersion: 2,
  });
}

function buildCandidatePoolsByAssetType(
  candidates: CouplingAttributionCandidate[]
): Map<ExtractedForensicsAsset['assetType'], CouplingAttributionCandidate[]> {
  const candidateIds = new Set<string>();
  const candidatesByAssetType = new Map<
    ExtractedForensicsAsset['assetType'],
    CouplingAttributionCandidate[]
  >([
    ['fbx', []],
    ['png', []],
  ]);
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.attributionId)) {
      throw new CouplingServiceRequestError('Duplicate attribution candidate identifier', 502);
    }
    candidateIds.add(candidate.attributionId);
    if (candidate.materializerType === 'zip') {
      candidatesByAssetType.get('fbx')?.push(candidate);
      candidatesByAssetType.get('png')?.push(candidate);
      continue;
    }
    candidatesByAssetType.get(candidate.materializerType)?.push(candidate);
  }
  return candidatesByAssetType;
}

function mergeAttributionCandidates(
  ...groups: CouplingAttributionCandidate[][]
): CouplingAttributionCandidate[] {
  const merged = new Map<string, CouplingAttributionCandidate>();
  for (const candidate of groups.flat()) {
    merged.set(candidate.attributionId, candidate);
  }
  return [...merged.values()];
}

function attributionBasename(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return (normalized.slice(normalized.lastIndexOf('/') + 1) || normalized).toLowerCase();
}

function prioritizeCandidatesForAssets(
  assets: ExtractedForensicsAsset[],
  candidates: CouplingAttributionCandidate[]
): CouplingAttributionCandidate[] {
  const assetBasenames = new Set(assets.map((asset) => attributionBasename(asset.assetPath)));
  const preferred: CouplingAttributionCandidate[] = [];
  const remaining: CouplingAttributionCandidate[] = [];
  for (const candidate of candidates) {
    const target = assetBasenames.has(attributionBasename(candidate.normalizedPath))
      ? preferred
      : remaining;
    target.push(candidate);
  }
  return [...preferred, ...remaining];
}

function validateAttributionResult(
  input: ExtractedForensicsAsset[],
  candidates: CouplingAttributionCandidate[],
  payload: AttributeServiceResponse
): ForensicsScoreResult[] {
  const assetByPath = buildAssetMapByPath(input, 'attribution input');
  const candidateById = new Map(
    candidates.map((candidate) => [candidate.attributionId, candidate])
  );
  if (candidateById.size !== candidates.length) {
    throw new CouplingServiceRequestError('Duplicate attribution candidate identifier', 502);
  }
  if (payload.schemaVersion !== 2) {
    throw new CouplingServiceRequestError(
      'Coupling service returned an unsupported attribution schema',
      502
    );
  }
  const results = getServiceResults(payload);
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
    if (entry.matched === true) {
      const attributionId = entry.attributionId?.trim() || '';
      const buyerSubjectPseudonym = entry.buyerSubjectPseudonym?.trim() || '';
      const candidate = candidateById.get(attributionId);
      if (
        !candidate ||
        assetType !== inputEntry.assetType ||
        (candidate.materializerType !== 'zip' &&
          candidate.materializerType !== inputEntry.assetType) ||
        candidate.buyerSubjectPseudonym !== buyerSubjectPseudonym
      ) {
        throw new CouplingServiceRequestError(
          'Coupling service returned an unknown matched candidate',
          502
        );
      }
      validatedResults.set(assetPath, {
        assetPath,
        assetType,
        decoderKind: assetType,
        matchedAttributionId: attributionId,
        matchedBuyerSubjectPseudonym: buyerSubjectPseudonym,
        preclassification: 'decoded',
      });
      continue;
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
  const candidatesByAssetType = buildCandidatePoolsByAssetType(candidates);

  const sharedSecret = config.sharedSecret.trim();
  if (!sharedSecret) {
    throw new CouplingServiceConfigurationError('Coupling service shared secret is not configured');
  }

  const requestMaxBytes = resolveCouplingRequestMaxBytes(config);
  const resultsByPath = new Map<string, ForensicsScoreResult>();
  let batch: AttributionBatch = {
    assets: [],
    candidates: [],
    serializedAssets: [],
  };

  const runBatch = async (current: AttributionBatch): Promise<void> => {
    if (current.assets.length === 0) {
      return;
    }
    const prioritizedCandidates = prioritizeCandidatesForAssets(current.assets, current.candidates);
    const requestBody = buildAttributeRequestBody(current.serializedAssets, prioritizedCandidates);
    if (Buffer.byteLength(requestBody) > requestMaxBytes) {
      throw new CouplingServiceRequestError(
        'Coupling attribution asset exceeds the request size limit',
        502
      );
    }

    let response: Response;
    let responseText: string;
    try {
      ({ response, responseText } = await fetchCouplingServiceResponse(
        buildAttributeUrl(config.baseUrl),
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${sharedSecret}`,
            'Cache-Control': 'no-store',
            'Content-Type': 'application/json',
          },
          body: requestBody,
        },
        config,
        'Coupling attribution timed out',
        config.attributionTimeoutMs ?? config.requestTimeoutMs
      ));
    } catch (error) {
      if (
        error instanceof CouplingServiceRequestError ||
        error instanceof CouplingServiceConfigurationError
      ) {
        throw error;
      }
      throw new CouplingServiceRequestError('Coupling service is unreachable', 503);
    }

    const payload = parseResponsePayload<AttributeServiceResponse>(responseText);

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

    for (const result of validateAttributionResult(
      current.assets,
      prioritizedCandidates,
      payload
    )) {
      resultsByPath.set(result.assetPath, result);
    }
  };

  for (const asset of assets) {
    const compatibleCandidates = candidatesByAssetType.get(asset.assetType) ?? [];
    if (compatibleCandidates.length === 0) {
      continue;
    }
    const serializedAsset: SerializedAttributionAsset = {
      assetPath: asset.assetPath,
      assetType: asset.assetType,
      contentBase64: Buffer.from(await readFile(asset.filePath)).toString('base64'),
    };
    const nextBatch: AttributionBatch = {
      assets: [...batch.assets, asset],
      candidates: mergeAttributionCandidates(batch.candidates, compatibleCandidates),
      serializedAssets: [...batch.serializedAssets, serializedAsset],
    };

    if (
      batch.assets.length > 0 &&
      Buffer.byteLength(
        buildAttributeRequestBody(nextBatch.serializedAssets, nextBatch.candidates)
      ) > requestMaxBytes
    ) {
      await runBatch(batch);
      batch = {
        assets: [asset],
        candidates: [...compatibleCandidates],
        serializedAssets: [serializedAsset],
      };
      continue;
    }

    batch = nextBatch;
  }
  await runBatch(batch);

  return assets.map(
    (asset) =>
      resultsByPath.get(asset.assetPath) ?? {
        assetPath: asset.assetPath,
        assetType: asset.assetType,
        decoderKind: asset.assetType,
        preclassification: 'no-signal',
      }
  );
}
