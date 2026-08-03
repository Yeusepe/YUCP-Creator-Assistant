import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import type { ExtractedForensicsAsset } from './couplingForensicsArchives';
import type { MaterializationAttributionSubjectMapping } from './materializationControlClient';

export type CouplingForensicsServiceConfig = {
  attributionMaxCandidateEvaluationsPerRequest?: number;
  baseUrl: string;
  sharedSecret: string;
  requestTimeoutMs?: number;
  attributionTimeoutMs?: number;
  /** Epoch ms after which no further attribution batches are started; the scan
   * returns what it has with `complete: false` instead of failing. */
  deadlineAtMs?: number;
  maxConcurrentRequests?: number;
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

export type CouplingAttributionOutcome = {
  /** False when the deadline stopped the scan before every batch ran. */
  complete: boolean;
  /** Candidate evaluations actually performed (asset x candidate pairs). */
  evaluationsPerformed: number;
  results: ForensicsScoreResult[];
};

// Each evaluate request boots a fresh sandbox in the materializer container and
// re-decodes the asset once per candidate key; healthy 64-candidate batches
// measure 8.6-12.5s in production, so 15s tripped on ordinary variance.
const ATTRIBUTION_REQUEST_TIMEOUT_MS = 30_000;
const ATTRIBUTION_REQUEST_MAX_BYTES = 24 * 1024 * 1024;
const ATTRIBUTION_MAX_CANDIDATE_EVALUATIONS_PER_REQUEST = 64;
// The materializer runs one 512 MiB sandbox per in-flight request on a
// standard-4 instance; three concurrent batches fit with headroom.
const ATTRIBUTION_MAX_CONCURRENT_REQUESTS = 3;
// Below this remaining budget a batch cannot finish, so the scan stops instead
// of starting work the deadline would cut off mid-flight.
export const ATTRIBUTION_DEADLINE_STOP_FLOOR_MS = 5_000;
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
  /**
   * Which broker derivation minted the record's file key ('v2' container jobs,
   * 'v3' worker-lane jobs). The coupling service re-derives with the same
   * family; a mismatched family decodes nothing.
   */
  keyDerivation: 'v2' | 'v3';
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

function buildRevealUrl(baseUrl: string): string {
  return buildCouplingServiceUrl(baseUrl, 'v2/internal/coupling/attribution/reveal');
}

/**
 * Exactly what the control plane hands back, reused rather than restated so a
 * field change on one side cannot silently diverge from the other.
 */
export type CouplingRevealSubject = MaterializationAttributionSubjectMapping;

/**
 * Opens the sealed mappings behind matched records, via the one service that
 * holds the master epoch key.
 *
 * A reveal that fails must not fail the trace: the creator still deserves the
 * match they earned, just without a name attached. Callers get whatever opened
 * and nothing for the rest.
 */
export async function revealCouplingSubjects(
  input: {
    creatorId: string;
    productId: string;
    subjects: CouplingRevealSubject[];
  },
  config: CouplingForensicsServiceConfig
): Promise<Map<string, string>> {
  const revealed = new Map<string, string>();
  if (input.subjects.length === 0) {
    return revealed;
  }
  const sharedSecret = config.sharedSecret.trim();
  if (!sharedSecret) {
    throw new CouplingServiceConfigurationError('Coupling service shared secret is not configured');
  }
  const { response, responseText } = await fetchCouplingServiceResponse(
    buildRevealUrl(config.baseUrl),
    {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${sharedSecret}`,
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        creatorId: input.creatorId,
        productId: input.productId,
        subjects: input.subjects,
      }),
    },
    config,
    'Coupling attribution reveal timed out',
    config.attributionTimeoutMs ?? config.requestTimeoutMs
  );
  if (!response.ok) {
    throw new CouplingServiceRequestError(
      `Coupling attribution reveal failed with status ${response.status}`,
      response.status
    );
  }
  const payload = parseResponsePayload<{
    revealed?: Array<{ attributionId?: string; buyerId?: string }>;
  }>(responseText);
  if (!payload || !Array.isArray(payload.revealed)) {
    throw new CouplingServiceRequestError('Coupling service returned an invalid reveal', 502);
  }
  const requested = new Set(input.subjects.map((subject) => subject.attributionId));
  for (const entry of payload.revealed) {
    // The declared type is a compile-time assertion over parsed JSON, not a
    // runtime guarantee: a number here would throw instead of rejecting.
    const rawAttributionId: unknown = entry?.attributionId;
    const rawBuyerId: unknown = entry?.buyerId;
    const attributionId = typeof rawAttributionId === 'string' ? rawAttributionId.trim() : '';
    const buyerId = typeof rawBuyerId === 'string' ? rawBuyerId.trim() : '';
    // Only what was asked about: an id the caller never sent would mean the
    // service is pairing buyers with records of its own choosing.
    if (!attributionId || !buyerId || !requested.has(attributionId)) {
      throw new CouplingServiceRequestError(
        'Coupling service revealed a subject outside the request',
        502
      );
    }
    revealed.set(attributionId, buyerId);
  }
  return revealed;
}

type SerializedAttributionAsset = {
  assetPath: string;
  assetType: 'png' | 'fbx';
  contentBase64: string;
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

export function attributionBasename(value: string): string {
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

function resolveAttributionMaximumCandidateEvaluations(
  config: CouplingForensicsServiceConfig
): number {
  const maximum =
    config.attributionMaxCandidateEvaluationsPerRequest ??
    ATTRIBUTION_MAX_CANDIDATE_EVALUATIONS_PER_REQUEST;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 512) {
    throw new CouplingServiceConfigurationError(
      'Coupling attribution request work limit is invalid'
    );
  }
  return maximum;
}

function resolveAttributionConcurrency(config: CouplingForensicsServiceConfig): number {
  const configured = config.maxConcurrentRequests;
  if (configured === undefined) {
    return ATTRIBUTION_MAX_CONCURRENT_REQUESTS;
  }
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 8) {
    throw new CouplingServiceConfigurationError('Coupling attribution concurrency is invalid');
  }
  return configured;
}

function mergeAttributionScore(
  previous: ForensicsScoreResult | undefined,
  next: ForensicsScoreResult
): ForensicsScoreResult {
  if (!previous || next.preclassification === 'decoded') {
    return next;
  }
  if (previous.preclassification === 'no-signal' && next.preclassification === 'likely-stripped') {
    return next;
  }
  return previous;
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
): Promise<CouplingAttributionOutcome> {
  if (assets.length === 0) {
    return { complete: true, evaluationsPerformed: 0, results: [] };
  }
  if (candidates.length === 0) {
    return {
      complete: true,
      evaluationsPerformed: 0,
      results: assets.map((asset) => ({
        assetPath: asset.assetPath,
        assetType: asset.assetType,
        decoderKind: asset.assetType,
        preclassification: 'no-signal',
      })),
    };
  }
  buildAssetMapByPath(assets, 'attribution input');
  const candidatesByAssetType = buildCandidatePoolsByAssetType(candidates);

  const sharedSecret = config.sharedSecret.trim();
  if (!sharedSecret) {
    throw new CouplingServiceConfigurationError('Coupling service shared secret is not configured');
  }

  const requestMaxBytes = resolveCouplingRequestMaxBytes(config);
  const maximumCandidateEvaluations = resolveAttributionMaximumCandidateEvaluations(config);
  const concurrency = resolveAttributionConcurrency(config);
  const deadlineAtMs = config.deadlineAtMs;
  const remainingBudgetMs = (): number | undefined =>
    deadlineAtMs === undefined ? undefined : deadlineAtMs - Date.now();
  const resultsByPath = new Map<string, ForensicsScoreResult>();
  let evaluationsPerformed = 0;
  let deadlineStopped = false;

  const runBatch = async (input: {
    asset: ExtractedForensicsAsset;
    budgetMs: number | undefined;
    candidates: CouplingAttributionCandidate[];
    serializedAsset: SerializedAttributionAsset;
  }): Promise<ForensicsScoreResult> => {
    const requestBody = buildAttributeRequestBody([input.serializedAsset], input.candidates);
    if (Buffer.byteLength(requestBody) > requestMaxBytes) {
      throw new CouplingServiceRequestError(
        'Coupling attribution asset exceeds the request size limit',
        502
      );
    }

    const baseTimeoutMs = resolveCouplingRequestTimeoutMs(
      config.attributionTimeoutMs ?? config.requestTimeoutMs
    );
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
        input.budgetMs === undefined
          ? baseTimeoutMs
          : Math.max(1, Math.min(baseTimeoutMs, input.budgetMs))
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

    const results = validateAttributionResult([input.asset], input.candidates, payload);
    const result = results[0];
    if (!result) {
      throw new CouplingServiceRequestError(
        'Coupling service returned an invalid attribution result',
        502
      );
    }
    return result;
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
    const prioritizedCandidates = prioritizeCandidatesForAssets([asset], compatibleCandidates);
    const batches: CouplingAttributionCandidate[][] = [];
    let offset = 0;
    while (offset < prioritizedCandidates.length) {
      const candidateBatch = prioritizedCandidates.slice(
        offset,
        offset + maximumCandidateEvaluations
      );
      while (
        candidateBatch.length > 0 &&
        Buffer.byteLength(buildAttributeRequestBody([serializedAsset], candidateBatch)) >
          requestMaxBytes
      ) {
        candidateBatch.pop();
      }
      if (candidateBatch.length === 0) {
        throw new CouplingServiceRequestError(
          'Coupling attribution asset exceeds the request size limit',
          502
        );
      }
      offset += candidateBatch.length;
      batches.push(candidateBatch);
    }

    let nextBatchIndex = 0;
    let decoded = false;
    const drainBatches = async (): Promise<void> => {
      for (;;) {
        if (decoded) {
          return;
        }
        const budgetMs = remainingBudgetMs();
        if (budgetMs !== undefined && budgetMs < ATTRIBUTION_DEADLINE_STOP_FLOOR_MS) {
          deadlineStopped = true;
          return;
        }
        const batchIndex = nextBatchIndex;
        if (batchIndex >= batches.length) {
          return;
        }
        nextBatchIndex += 1;
        const candidateBatch = batches[batchIndex] as CouplingAttributionCandidate[];
        let result: ForensicsScoreResult;
        try {
          result = await runBatch({
            asset,
            budgetMs,
            candidates: candidateBatch,
            serializedAsset,
          });
        } catch (error) {
          const budgetAfter = remainingBudgetMs();
          if (
            budgetAfter !== undefined &&
            budgetAfter <= 0 &&
            error instanceof CouplingServiceRequestError &&
            error.status === 504
          ) {
            // The deadline cut this batch off, not the service failing: keep
            // the partial scan instead of discarding the work already done.
            deadlineStopped = true;
            return;
          }
          throw error;
        }
        evaluationsPerformed += candidateBatch.length;
        resultsByPath.set(
          asset.assetPath,
          mergeAttributionScore(resultsByPath.get(asset.assetPath), result)
        );
        if (result.preclassification === 'decoded') {
          decoded = true;
          return;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, batches.length) }, () => drainBatches())
    );
    if (deadlineStopped) {
      break;
    }
  }

  return {
    complete: !deadlineStopped,
    evaluationsPerformed,
    results: assets.map(
      (asset) =>
        resultsByPath.get(asset.assetPath) ?? {
          assetPath: asset.assetPath,
          assetType: asset.assetType,
          decoderKind: asset.assetType,
          preclassification: 'no-signal',
        }
    ),
  };
}
