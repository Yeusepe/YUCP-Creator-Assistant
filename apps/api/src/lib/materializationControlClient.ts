import type { PackageInstallMaterializationControl } from '../routes/packageInstallSessions';
import type { CouplingAttributionCandidate } from './couplingForensicsService';

const CREATE_PATH = '/v2/internal/materialization-jobs/create';
const STATUS_PATH = '/v2/internal/materialization-jobs/status';
const ATTRIBUTION_CANDIDATES_PATH = '/v2/internal/materialization-attribution/candidates';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const MAXIMUM_RESPONSE_BYTES = 64 * 1024;
const MAXIMUM_ATTRIBUTION_RESPONSE_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

type CreateJobInput = Parameters<PackageInstallMaterializationControl['createJob']>[0] & {
  traceparent?: string;
};

export type MaterializationStatus =
  | {
      queuePosition: number;
      state: 'MATERIALIZING' | 'QUEUED' | 'VERIFYING';
      status: 'pending';
    }
  | {
      errorCode: string;
      status: 'failed';
    }
  | {
      receipt: string;
      receiptId: string;
      status: 'succeeded';
    };

export interface MaterializationControlClient extends PackageInstallMaterializationControl {
  createJob(input: CreateJobInput): Promise<void>;
  getStatus(input: { grantJti: string; jobId: string }): Promise<MaterializationStatus>;
  listAttributionCandidates(input: {
    creatorId: string;
    productId: string;
  }): Promise<MaterializationAttributionCandidatePage>;
}

export type MaterializationAttributionCandidatePage = {
  candidateLimit: number;
  candidates: MaterializationAttributionCandidate[];
  truncated: boolean;
};

export type MaterializationAttributionCandidate = CouplingAttributionCandidate & {
  createdAt: number;
};

export interface MaterializationControlClientConfig {
  baseUrl: string;
  fetchImplementation?: (request: Request) => Promise<Response>;
  sharedSecret: string;
  timeoutMs?: number;
}

export type MaterializationControlEnvironment = {
  MATERIALIZATION_API_SHARED_SECRET?: string;
  MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL?: string;
  MATERIALIZATION_CONTROL_PLANE_TIMEOUT_MS?: string;
};

function requireBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Materialization control-plane URL must be an absolute origin');
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
    throw new Error('Materialization control-plane URL must be an HTTPS or loopback HTTP origin');
  }
  return parsed.origin;
}

function requireText(value: unknown, name: string, maximum = 512): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value.trim(), 'utf8') > maximum
  ) {
    throw new Error(`Materialization control-plane ${name} is invalid`);
  }
  return value.trim();
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Materialization control-plane returned an invalid response');
  }
  return value as Record<string, unknown>;
}

function validateStatus(value: unknown): MaterializationStatus {
  const body = requireObject(value);
  if (body.status === 'pending') {
    if (
      !Number.isSafeInteger(body.queuePosition) ||
      (body.queuePosition as number) < 0 ||
      (body.state !== 'QUEUED' && body.state !== 'MATERIALIZING' && body.state !== 'VERIFYING')
    ) {
      throw new Error('Materialization control-plane returned an invalid response');
    }
    return {
      queuePosition: body.queuePosition as number,
      state: body.state,
      status: 'pending',
    };
  }
  if (body.status === 'failed') {
    return {
      errorCode: requireText(body.errorCode, 'error code', 128),
      status: 'failed',
    };
  }
  if (body.status === 'succeeded') {
    return {
      receipt: requireText(body.receipt, 'receipt', 256 * 1024),
      receiptId: requireText(body.receiptId, 'receipt identifier', 128),
      status: 'succeeded',
    };
  }
  throw new Error('Materialization control-plane returned an invalid response');
}

function requireSha256(value: unknown, name: string): string {
  const text = requireText(value, name, 64);
  if (!SHA256_PATTERN.test(text)) {
    throw new Error(`Materialization control-plane ${name} is invalid`);
  }
  return text;
}

function validateAttributionCandidate(value: unknown): MaterializationAttributionCandidate {
  const candidate = requireObject(value);
  const materializerType = candidate.materializerType;
  const outputFormat = candidate.outputFormat;
  if (
    (materializerType !== 'fbx' && materializerType !== 'png') ||
    outputFormat !== 'zip' ||
    !Number.isSafeInteger(candidate.keyEpoch) ||
    (candidate.keyEpoch as number) < 0 ||
    !Number.isSafeInteger(candidate.leaseGeneration) ||
    (candidate.leaseGeneration as number) < 1
  ) {
    throw new Error('Materialization control-plane attribution candidate is invalid');
  }
  const buyerSubjectPseudonym = requireText(
    candidate.buyerSubjectPseudonym,
    'buyer subject pseudonym',
    128
  );
  if (
    !BASE64URL_PATTERN.test(buyerSubjectPseudonym) ||
    Buffer.from(buyerSubjectPseudonym, 'base64url').byteLength !== 32
  ) {
    throw new Error('Materialization control-plane buyer subject pseudonym is invalid');
  }
  return {
    algorithmVersion: requireText(candidate.algorithmVersion, 'attribution algorithm version'),
    attributionId: requireText(candidate.attributionId, 'attribution identifier'),
    attributionTokenHash: requireSha256(candidate.attributionTokenHash, 'attribution token hash'),
    buyerSubjectPseudonym,
    capabilityId: requireText(candidate.capabilityId, 'capability identifier'),
    createdAt:
      Number.isSafeInteger(candidate.createdAt) && (candidate.createdAt as number) >= 0
        ? (candidate.createdAt as number)
        : (() => {
            throw new Error('Materialization control-plane attribution creation time is invalid');
          })(),
    creatorId: requireText(candidate.creatorId, 'creator identifier'),
    jobId: requireText(candidate.jobId, 'job identifier'),
    keyEpoch: candidate.keyEpoch as number,
    leaseGeneration: candidate.leaseGeneration as number,
    materializerType,
    normalizedPath: requireText(candidate.normalizedPath, 'normalized path', 1_024),
    outputFormat,
    pluginVersion: requireText(candidate.pluginVersion, 'plugin version'),
    protectedSourceRoot: requireSha256(candidate.protectedSourceRoot, 'protected source root'),
    releaseRoot: requireSha256(candidate.releaseRoot, 'release root'),
    sourceSha256: requireSha256(candidate.sourceSha256, 'source digest'),
  };
}

function validateAttributionCandidates(value: unknown): MaterializationAttributionCandidatePage {
  const body = requireObject(value);
  if (
    !Number.isSafeInteger(body.candidateLimit) ||
    (body.candidateLimit as number) < 1 ||
    (body.candidateLimit as number) > 4_096 ||
    typeof body.truncated !== 'boolean' ||
    !Array.isArray(body.candidates) ||
    body.candidates.length > (body.candidateLimit as number)
  ) {
    throw new Error('Materialization control-plane returned an invalid response');
  }
  return {
    candidateLimit: body.candidateLimit as number,
    candidates: body.candidates.map(validateAttributionCandidate),
    truncated: body.truncated,
  };
}

export function createMaterializationControlClient(
  config: MaterializationControlClientConfig
): MaterializationControlClient {
  const baseUrl = requireBaseUrl(config.baseUrl);
  const sharedSecret = config.sharedSecret.trim();
  if (Buffer.byteLength(sharedSecret, 'utf8') < 24) {
    throw new Error('Materialization API shared secret must contain at least 24 UTF-8 bytes');
  }
  const timeoutMs = config.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('Materialization control-plane timeout is invalid');
  }
  const fetchImplementation = config.fetchImplementation ?? ((request: Request) => fetch(request));

  async function post(
    path: string,
    body: Record<string, unknown>,
    expectedStatus: number,
    traceparent?: string,
    maximumResponseBytes = MAXIMUM_RESPONSE_BYTES
  ): Promise<unknown> {
    if (traceparent && !TRACEPARENT_PATTERN.test(traceparent)) {
      throw new Error('Materialization trace context is invalid');
    }
    const response = await fetchImplementation(
      new Request(`${baseUrl}${path}`, {
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${sharedSecret}`,
          'Content-Type': 'application/json',
          ...(traceparent ? { traceparent } : {}),
        },
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
      })
    );
    const declaredLength = response.headers.get('content-length');
    if (
      declaredLength &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumResponseBytes)
    ) {
      throw new Error('Materialization control-plane returned an invalid response');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maximumResponseBytes) {
      throw new Error('Materialization control-plane returned an invalid response');
    }
    if (response.status !== expectedStatus) {
      throw new Error(
        `Materialization control-plane rejected the request with HTTP ${response.status}`
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Materialization control-plane returned an invalid response');
    }
  }

  return {
    async createJob(input) {
      const { traceparent, ...body } = input;
      const response = requireObject(await post(CREATE_PATH, body, 202, traceparent));
      if (response.jobId !== input.jobId || response.status !== 'queued') {
        throw new Error('Materialization control-plane returned an invalid response');
      }
    },
    async getStatus(input) {
      return validateStatus(await post(STATUS_PATH, input, 200));
    },
    async listAttributionCandidates(input) {
      return validateAttributionCandidates(
        await post(
          ATTRIBUTION_CANDIDATES_PATH,
          input,
          200,
          undefined,
          MAXIMUM_ATTRIBUTION_RESPONSE_BYTES
        )
      );
    },
  };
}

export function loadMaterializationControlClient(
  env: MaterializationControlEnvironment
): MaterializationControlClient | null {
  const baseUrl = env.MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL?.trim();
  const sharedSecret = env.MATERIALIZATION_API_SHARED_SECRET?.trim();
  if (!baseUrl && !sharedSecret) {
    return null;
  }
  if (!baseUrl || !sharedSecret) {
    throw new Error(
      'MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL and MATERIALIZATION_API_SHARED_SECRET must be configured together'
    );
  }
  const timeoutText = env.MATERIALIZATION_CONTROL_PLANE_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutText ? Number(timeoutText) : undefined;
  return createMaterializationControlClient({
    baseUrl,
    sharedSecret,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}
