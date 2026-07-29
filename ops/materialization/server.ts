import { randomBytes, timingSafeEqual } from 'node:crypto';
import { MAX_PACKAGE_INSTALLER_HELPER_BYTES } from '@yucp/shared/packageInstallerLimits';
import { openCatalogDatabase, runCatalogMigrations, TufRepositoryCatalog } from '../catalog';
import {
  hydrateEnvFromInfisical,
  loadCasConfig,
  loadStorageRoleConfig,
  STORAGE_ROLE_PREFIXES,
} from '../storage-core/config';
import { verifyDpopProof } from '../storage-core/dpop';
import { S3ExactStoragePort } from '../storage-core/exactStorage';
import { packageContractKeyId } from '../storage-core/packageContractsV2';
import { parseTufRepositoryRoutePath } from '../storage-core/tufRepositoryPath';
import { ExactTufRepositoryReader } from '../storage-core/tufRepositoryReader';
import { createMaterializationKeyBrokerClient } from './keyBrokerClient';
import {
  type CompletedRendition,
  type ConsumedMaterializationCapability,
  DEFAULT_MATERIALIZATION_STORAGE_GC_PIN_RETENTION_SECONDS,
  MaterializationBroker,
  type PreparedRenditionUpload,
} from './materializationBroker';
import { S3RenditionStoragePort } from './renditionStorage';

const CONSUME_PATH = '/v2/internal/materialization-capabilities/consume';
const UPLOAD_TICKET_PATH = '/v2/internal/materialization-renditions/upload-ticket';
const COMPLETE_PATH = '/v2/internal/materialization-renditions/complete';
const CREATE_JOB_PATH = '/v2/internal/materialization-jobs/create';
const CLAIM_JOB_PATH = '/v2/internal/materialization-jobs/claim';
const RENEW_JOB_PATH = '/v2/internal/materialization-jobs/renew';
const STATUS_JOB_PATH = '/v2/internal/materialization-jobs/status';
const FAIL_JOB_PATH = '/v2/internal/materialization-jobs/fail';
const ATTRIBUTION_CANDIDATES_PATH = '/v2/internal/materialization-attribution/candidates';
const PACKAGE_INSTALLER_TUF_PREFIX = '/v2/internal/package-installer/tuf/';
const ATTRIBUTION_CANDIDATE_PAGE_LIMIT = 512;
const REQUEST_BODY_LIMIT = 64 * 1_024;
const CAPABILITY_REQUEST_BODY_LIMIT = 2 * 1_024 * 1_024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

type ConsumeCapabilityInput = Parameters<MaterializationBroker['consumeCapability']>[0];
type PrepareRenditionInput = Parameters<MaterializationBroker['prepareRenditionUpload']>[0];
type CompleteRenditionInput = Parameters<MaterializationBroker['completeRendition']>[0];
type CreateInstallJobInput = Parameters<MaterializationBroker['createInstallJob']>[0];
type ClaimJobInput = Parameters<MaterializationBroker['claimNextJob']>[0];
type RenewJobInput = Parameters<MaterializationBroker['renewClaimLease']>[0];
type IssueCapabilityInput = Parameters<MaterializationBroker['issueCapability']>[0];
type FailCapabilityJobInput = Parameters<MaterializationBroker['failCapabilityJob']>[0];
type GetJobStatusInput = Parameters<MaterializationBroker['getJobStatus']>[0];

type MaterializationControlBroker = {
  claimNextJob(input: ClaimJobInput): ReturnType<MaterializationBroker['claimNextJob']>;
  consumeCapability(input: ConsumeCapabilityInput): Promise<ConsumedMaterializationCapability>;
  completeRendition(input: CompleteRenditionInput): Promise<CompletedRendition>;
  createInstallJob(input: CreateInstallJobInput): Promise<void>;
  failCapabilityJob(input: FailCapabilityJobInput): Promise<void>;
  getJobStatus(input: GetJobStatusInput): ReturnType<MaterializationBroker['getJobStatus']>;
  issueCapability(
    input: IssueCapabilityInput
  ): ReturnType<MaterializationBroker['issueCapability']>;
  listAttributionCandidates?: (
    input: Parameters<MaterializationBroker['listAttributionCandidates']>[0]
  ) => ReturnType<MaterializationBroker['listAttributionCandidates']>;
  prepareRenditionUpload(input: PrepareRenditionInput): Promise<PreparedRenditionUpload>;
  renewClaimLease(input: RenewJobInput): ReturnType<MaterializationBroker['renewClaimLease']>;
};

type MaterializationControlPlaneEvent = {
  durationMs: number;
  errorCode?: string;
  event:
    | 'materialization.capability.consume'
    | 'materialization.attribution.candidates'
    | 'materialization.job.claim'
    | 'materialization.job.create'
    | 'materialization.job.fail'
    | 'materialization.job.renew'
    | 'materialization.job.status'
    | 'materialization.rendition.complete'
    | 'materialization.rendition.upload_ticket'
    | 'package_installer.tuf.read';
  status: 'accepted' | 'rejected';
  traceId: string;
};

export type MaterializationControlPlaneConfig = {
  apiSharedSecret: string;
  broker: MaterializationControlBroker;
  capabilityKeyId: Uint8Array;
  capabilityLifetimeSeconds: number;
  capabilityPrivateKey: Uint8Array;
  capabilityPublicKey: Uint8Array;
  keyEpoch: number;
  materializationAlgorithm: string;
  materializerSharedSecret: string;
  now?: () => Date;
  onEvent?: (event: MaterializationControlPlaneEvent) => void;
  packageInstallerTufRepository?: {
    read(
      role: 'metadata' | 'targets',
      repositoryPath: string
    ): Promise<{ body: Uint8Array; contentType: string } | null>;
  };
  pluginVersion: string;
  publicBaseUrl: string;
};

class RequestBoundaryError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RequestBoundaryError';
    this.status = status;
    this.code = code;
  }
}

function noStoreJson(body: unknown, status: number, traceId: string): Response {
  return Response.json(body, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      'X-Trace-Id': traceId,
    },
    status,
  });
}

function constantTimeAuthorizationMatches(header: string | null, sharedSecret: string): boolean {
  const expected = Buffer.from(`Bearer ${sharedSecret}`, 'utf8');
  const actual = Buffer.from(header ?? '', 'utf8');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function createTraceId(request: Request): string {
  const traceparent = request.headers.get('traceparent');
  const match = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(traceparent ?? '');
  if (match?.[1] && !/^0{32}$/.test(match[1])) {
    return match[1];
  }
  return randomBytes(16).toString('hex');
}

async function readBoundedJson(
  request: Request,
  limit = REQUEST_BODY_LIMIT
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new RequestBoundaryError(415, 'content_type_invalid', 'Content type is invalid');
  }
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > limit)) {
    throw new RequestBoundaryError(413, 'request_too_large', 'Request body is too large');
  }
  const reader = request.body?.getReader();
  if (!reader) {
    throw new RequestBoundaryError(400, 'body_missing', 'Request body is required');
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new RequestBoundaryError(413, 'request_too_large', 'Request body is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new RequestBoundaryError(400, 'body_invalid', 'Request body is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RequestBoundaryError(400, 'body_invalid', 'Request body is invalid');
  }
  return parsed as Record<string, unknown>;
}

function requireBase64Url(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value || value.length > maxLength || !BASE64URL.test(value)) {
    throw new RequestBoundaryError(400, `${name}_invalid`, `${name} is invalid`);
  }
  return value;
}

function requireProof(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 8_192 ||
    value.split('.').length !== 3
  ) {
    throw new RequestBoundaryError(400, 'proof_invalid', 'proof is invalid');
  }
  return value;
}

function requireString(value: unknown, name: string, maxLength = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new RequestBoundaryError(400, `${name}_invalid`, `${name} is invalid`);
  }
  return value.trim();
}

function requireInteger(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RequestBoundaryError(400, `${name}_invalid`, `${name} is invalid`);
  }
  return value as number;
}

function requireSha256(value: unknown, name: string): Uint8Array {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new RequestBoundaryError(400, `${name}_invalid`, `${name} is invalid`);
  }
  return Buffer.from(value, 'hex');
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestBoundaryError(400, `${name}_invalid`, `${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, name: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new RequestBoundaryError(400, `${name}_invalid`, `${name} is invalid`);
  }
  return value;
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new RequestBoundaryError(400, 'body_fields_invalid', 'Request body fields are invalid');
  }
}

function parseOutputFiles(value: unknown): CompleteRenditionInput['outputFiles'] {
  return requireArray(value, 'output_files', 512).map((entry) => {
    const file = requireObject(entry, 'output_file');
    requireExactKeys(file, ['attributionId', 'normalizedPath', 'outputBytes', 'outputSha256']);
    return {
      attributionId: requireString(file.attributionId, 'attribution_id'),
      normalizedPath: requireString(file.normalizedPath, 'normalized_path', 1_024),
      outputBytes: requireInteger(file.outputBytes, 'output_bytes'),
      outputSha256: requireString(file.outputSha256, 'output_sha256', 64),
    };
  });
}

function parseAttributionRecords(value: unknown): CompleteRenditionInput['attributionRecords'] {
  return requireArray(value, 'attribution_records', 512).map((entry) => {
    const record = requireObject(entry, 'attribution_record');
    requireExactKeys(record, [
      'attributionId',
      'attributionTokenHash',
      'normalizedPath',
      'sourceSha256',
    ]);
    return {
      attributionId: requireString(record.attributionId, 'attribution_id'),
      attributionTokenHash: requireString(
        record.attributionTokenHash,
        'attribution_token_hash',
        64
      ),
      normalizedPath: requireString(record.normalizedPath, 'normalized_path', 1_024),
      sourceSha256: requireString(record.sourceSha256, 'source_sha256', 64),
    };
  });
}

function publicRouteUrl(publicBaseUrl: string, path: string): string {
  const base = new URL(publicBaseUrl);
  if (
    (base.protocol !== 'https:' &&
      !(
        base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
      )) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error('Materialization control-plane public base URL is invalid');
  }
  return new URL(path, `${base.toString().replace(/\/$/, '')}/`).toString();
}

function classifyMaterializationControlError(pathname: string, error: unknown): string | null {
  if (pathname !== CREATE_JOB_PATH || !(error instanceof Error)) {
    return null;
  }
  if (error.message.includes('ready canonical package version')) {
    return 'materialization_source_mismatch';
  }
  if (error.message.includes('conflicts with different immutable input')) {
    return 'materialization_job_conflict';
  }
  if (
    error.name === 'TimeoutError' ||
    error.message.includes('key broker') ||
    error.message.includes('subject preparation')
  ) {
    return 'materialization_dependency_unavailable';
  }
  return null;
}

export function createMaterializationControlPlaneHandler(
  config: MaterializationControlPlaneConfig
): (request: Request) => Promise<Response> {
  if (
    Buffer.byteLength(config.apiSharedSecret, 'utf8') < 24 ||
    Buffer.byteLength(config.materializerSharedSecret, 'utf8') < 24
  ) {
    throw new Error('Materialization control-plane secrets must contain at least 24 bytes');
  }
  if (
    config.capabilityKeyId.byteLength < 1 ||
    config.capabilityKeyId.byteLength > 64 ||
    config.capabilityPrivateKey.byteLength !== 32 ||
    config.capabilityPublicKey.byteLength !== 32 ||
    !Number.isSafeInteger(config.capabilityLifetimeSeconds) ||
    config.capabilityLifetimeSeconds < 1 ||
    config.capabilityLifetimeSeconds > 15 * 60 ||
    !Number.isSafeInteger(config.keyEpoch) ||
    config.keyEpoch < 0 ||
    !config.materializationAlgorithm.trim() ||
    !config.pluginVersion.trim()
  ) {
    throw new Error('Materialization control-plane signing or runtime configuration is invalid');
  }
  const routeUrls = new Map([
    [CONSUME_PATH, publicRouteUrl(config.publicBaseUrl, CONSUME_PATH)],
    [UPLOAD_TICKET_PATH, publicRouteUrl(config.publicBaseUrl, UPLOAD_TICKET_PATH)],
    [COMPLETE_PATH, publicRouteUrl(config.publicBaseUrl, COMPLETE_PATH)],
    [CREATE_JOB_PATH, publicRouteUrl(config.publicBaseUrl, CREATE_JOB_PATH)],
    [CLAIM_JOB_PATH, publicRouteUrl(config.publicBaseUrl, CLAIM_JOB_PATH)],
    [RENEW_JOB_PATH, publicRouteUrl(config.publicBaseUrl, RENEW_JOB_PATH)],
    [STATUS_JOB_PATH, publicRouteUrl(config.publicBaseUrl, STATUS_JOB_PATH)],
    [FAIL_JOB_PATH, publicRouteUrl(config.publicBaseUrl, FAIL_JOB_PATH)],
    [
      ATTRIBUTION_CANDIDATES_PATH,
      publicRouteUrl(config.publicBaseUrl, ATTRIBUTION_CANDIDATES_PATH),
    ],
  ]);
  const apiPaths = new Set([ATTRIBUTION_CANDIDATES_PATH, CREATE_JOB_PATH, STATUS_JOB_PATH]);
  const now = config.now ?? (() => new Date());

  return async (request: Request): Promise<Response> => {
    const traceId = createTraceId(request);
    const startedAt = performance.now();
    const url = new URL(request.url);
    const tufRoute = config.packageInstallerTufRepository
      ? parseTufRepositoryRoutePath(url.pathname, PACKAGE_INSTALLER_TUF_PREFIX)
      : null;
    const routeUrl = tufRoute
      ? publicRouteUrl(config.publicBaseUrl, url.pathname)
      : routeUrls.get(url.pathname);
    const event: MaterializationControlPlaneEvent['event'] = tufRoute
      ? 'package_installer.tuf.read'
      : url.pathname === CREATE_JOB_PATH
        ? 'materialization.job.create'
        : url.pathname === ATTRIBUTION_CANDIDATES_PATH
          ? 'materialization.attribution.candidates'
          : url.pathname === CLAIM_JOB_PATH
            ? 'materialization.job.claim'
            : url.pathname === RENEW_JOB_PATH
              ? 'materialization.job.renew'
              : url.pathname === STATUS_JOB_PATH
                ? 'materialization.job.status'
                : url.pathname === FAIL_JOB_PATH
                  ? 'materialization.job.fail'
                  : url.pathname === UPLOAD_TICKET_PATH
                    ? 'materialization.rendition.upload_ticket'
                    : url.pathname === COMPLETE_PATH
                      ? 'materialization.rendition.complete'
                      : 'materialization.capability.consume';
    const emit = (status: 'accepted' | 'rejected', errorCode?: string) => {
      config.onEvent?.({
        durationMs: performance.now() - startedAt,
        ...(errorCode ? { errorCode } : {}),
        event,
        status,
        traceId,
      });
    };
    if (!routeUrl) {
      return noStoreJson({ error: 'not_found' }, 404, traceId);
    }
    if (request.method !== (tufRoute ? 'GET' : 'POST')) {
      return noStoreJson({ error: 'method_not_allowed' }, 405, traceId);
    }
    const requiredSecret =
      tufRoute || apiPaths.has(url.pathname)
        ? config.apiSharedSecret
        : config.materializerSharedSecret;
    if (!constantTimeAuthorizationMatches(request.headers.get('authorization'), requiredSecret)) {
      emit('rejected', 'service_auth_invalid');
      return noStoreJson({ error: 'unauthorized' }, 401, traceId);
    }
    try {
      if (tufRoute) {
        const object = await config.packageInstallerTufRepository?.read(
          tufRoute.role,
          tufRoute.repositoryPath
        );
        const limit =
          tufRoute.role === 'metadata' ? 4 * 1_024 * 1_024 : MAX_PACKAGE_INSTALLER_HELPER_BYTES;
        if (!object || object.body.byteLength < 1 || object.body.byteLength > limit) {
          emit('rejected', 'package_installer_tuf_object_not_found');
          return noStoreJson({ error: 'not_found' }, 404, traceId);
        }
        emit('accepted');
        return new Response(Buffer.from(object.body), {
          headers: {
            'Cache-Control': 'private, no-store',
            'Content-Length': String(object.body.byteLength),
            'Content-Type': object.contentType,
            'X-Content-Type-Options': 'nosniff',
            'X-Trace-Id': traceId,
          },
          status: 200,
        });
      }
      const requestNow = now();
      const carriesCapability =
        url.pathname === CONSUME_PATH ||
        url.pathname === UPLOAD_TICKET_PATH ||
        url.pathname === COMPLETE_PATH ||
        url.pathname === FAIL_JOB_PATH;
      const body = await readBoundedJson(
        request,
        carriesCapability ? CAPABILITY_REQUEST_BODY_LIMIT : REQUEST_BODY_LIMIT
      );
      if (url.pathname === CREATE_JOB_PATH) {
        requireExactKeys(body, [
          'bindingRoot',
          'buyerId',
          'creatorId',
          'grantJti',
          'jobId',
          'productId',
          'protectedSourceRoot',
          'releaseRoot',
          'sourceLogicalBytes',
          'sourceLogicalFiles',
          'sourceManifestSha256',
          'sourceVersionId',
        ]);
        const jobId = requireString(body.jobId, 'job_id', 128);
        await config.broker.createInstallJob({
          bindingRoot: requireSha256(body.bindingRoot, 'binding_root'),
          buyerId: requireString(body.buyerId, 'buyer_id'),
          creatorId: requireString(body.creatorId, 'creator_id'),
          grantJti: requireString(body.grantJti, 'grant_jti'),
          id: jobId,
          keyEpoch: config.keyEpoch,
          lane: 'large',
          materializationAlgorithm: config.materializationAlgorithm,
          outputFormat: 'zip',
          pluginVersion: config.pluginVersion,
          productId: requireString(body.productId, 'product_id'),
          protectedSourceRoot: requireSha256(body.protectedSourceRoot, 'protected_source_root'),
          releaseRoot: requireSha256(body.releaseRoot, 'release_root'),
          sourceLogicalBytes: requireInteger(body.sourceLogicalBytes, 'source_logical_bytes'),
          sourceLogicalFiles: requireInteger(body.sourceLogicalFiles, 'source_logical_files', 1),
          sourceManifestSha256: requireSha256(body.sourceManifestSha256, 'source_manifest_sha256'),
          sourceVersionId: requireString(body.sourceVersionId, 'source_version_id', 128),
          traceId,
        });
        emit('accepted');
        return noStoreJson({ jobId, status: 'queued' }, 202, traceId);
      }
      if (url.pathname === STATUS_JOB_PATH) {
        requireExactKeys(body, ['grantJti', 'jobId']);
        const result = await config.broker.getJobStatus({
          grantJti: requireString(body.grantJti, 'grant_jti'),
          jobId: requireString(body.jobId, 'job_id', 128),
        });
        emit('accepted');
        return noStoreJson(result, 200, traceId);
      }
      if (url.pathname === ATTRIBUTION_CANDIDATES_PATH) {
        requireExactKeys(body, [
          ...(body.candidateLimit === undefined ? [] : ['candidateLimit']),
          'creatorId',
          ...(body.cursor === undefined ? [] : ['cursor']),
          'productId',
        ]);
        if (!config.broker.listAttributionCandidates) {
          throw new Error('Materialization attribution lookup is unavailable');
        }
        const candidateLimit =
          body.candidateLimit === undefined
            ? undefined
            : requireInteger(body.candidateLimit, 'candidate_limit', 1);
        if (candidateLimit !== undefined && candidateLimit > ATTRIBUTION_CANDIDATE_PAGE_LIMIT) {
          throw new RequestBoundaryError(
            400,
            'candidate_limit_invalid',
            'candidate_limit is invalid'
          );
        }
        const result = await config.broker.listAttributionCandidates({
          ...(candidateLimit === undefined ? {} : { candidateLimit }),
          creatorId: requireString(body.creatorId, 'creator_id'),
          ...(body.cursor === undefined
            ? {}
            : { cursor: requireString(body.cursor, 'cursor', 2_048) }),
          productId: requireString(body.productId, 'product_id'),
        });
        emit('accepted');
        return noStoreJson(result, 200, traceId);
      }
      if (url.pathname === CLAIM_JOB_PATH) {
        requireExactKeys(body, ['lane', 'leaseDurationMs', 'materializerId', 'proofKeyThumbprint']);
        const lane = requireString(body.lane, 'lane', 32);
        if (lane !== 'large' && lane !== 'maintenance') {
          throw new RequestBoundaryError(400, 'lane_invalid', 'lane is invalid');
        }
        const materializerId = requireString(body.materializerId, 'materializer_id');
        const proofKeyThumbprint = Buffer.from(
          requireBase64Url(body.proofKeyThumbprint, 'proof_key_thumbprint', 64),
          'base64url'
        );
        if (proofKeyThumbprint.byteLength !== 32) {
          throw new RequestBoundaryError(
            400,
            'proof_key_thumbprint_invalid',
            'proof_key_thumbprint is invalid'
          );
        }
        const claim = await config.broker.claimNextJob({
          lane,
          leaseDurationMs: requireInteger(body.leaseDurationMs, 'lease_duration_ms', 1),
          leaseOwner: materializerId,
          now: requestNow,
        });
        if (claim.status !== 'claimed') {
          emit('accepted');
          return noStoreJson(claim, 200, traceId);
        }
        const signed = await config.broker.issueCapability({
          jobId: claim.jobId,
          keyId: config.capabilityKeyId,
          leaseGeneration: claim.leaseGeneration,
          leaseOwner: materializerId,
          lifetimeSeconds: config.capabilityLifetimeSeconds,
          now: requestNow,
          privateKey: config.capabilityPrivateKey,
          proofKeyThumbprint,
        });
        emit('accepted');
        return noStoreJson(
          {
            capability: Buffer.from(signed.coseSign1).toString('base64url'),
            capabilityId: signed.capability.capabilityId,
            jobId: claim.jobId,
            leaseExpiresAt: claim.leaseExpiresAt.toISOString(),
            leaseGeneration: claim.leaseGeneration,
            status: 'claimed',
          },
          200,
          traceId
        );
      }
      if (url.pathname === RENEW_JOB_PATH) {
        requireExactKeys(body, ['jobId', 'leaseDurationMs', 'leaseGeneration', 'materializerId']);
        const renewed = await config.broker.renewClaimLease({
          jobId: requireString(body.jobId, 'job_id', 128),
          leaseDurationMs: requireInteger(body.leaseDurationMs, 'lease_duration_ms', 1),
          leaseGeneration: requireInteger(body.leaseGeneration, 'lease_generation', 1),
          leaseOwner: requireString(body.materializerId, 'materializer_id'),
          now: requestNow,
        });
        emit('accepted');
        return noStoreJson(
          {
            jobId: renewed.jobId,
            leaseExpiresAt: renewed.leaseExpiresAt.toISOString(),
            leaseGeneration: renewed.leaseGeneration,
            status: renewed.status,
          },
          200,
          traceId
        );
      }

      const capability = requireBase64Url(
        body.capability,
        'capability',
        CAPABILITY_REQUEST_BODY_LIMIT
      );
      const proof = requireProof(body.proof);
      const materializerId = requireString(body.materializerId, 'materializer_id');
      const verifiedProof = await verifyDpopProof({
        accessToken: capability,
        method: 'POST',
        now: requestNow,
        proof,
        url: routeUrl,
      });

      let result:
        | ConsumedMaterializationCapability
        | PreparedRenditionUpload
        | CompletedRendition
        | { status: 'failed' };
      if (url.pathname === CONSUME_PATH) {
        requireExactKeys(body, ['capability', 'materializerId', 'proof']);
        result = await config.broker.consumeCapability({
          coseSign1: Buffer.from(capability, 'base64url'),
          expectedKeyId: config.capabilityKeyId,
          materializerId,
          now: requestNow,
          proofJti: verifiedProof.jti,
          publicKey: config.capabilityPublicKey,
          traceId,
          verifiedProofKeyThumbprint: verifiedProof.thumbprint,
        });
      } else if (url.pathname === UPLOAD_TICKET_PATH) {
        requireExactKeys(body, [
          'bytes',
          'capability',
          'capabilityId',
          'jobId',
          'leaseGeneration',
          'materializerId',
          'proof',
          'sha256',
        ]);
        result = await config.broker.prepareRenditionUpload({
          bytes: requireInteger(body.bytes, 'bytes', 1),
          capabilityId: requireString(body.capabilityId, 'capability_id', 128),
          coseSign1: Buffer.from(capability, 'base64url'),
          jobId: requireString(body.jobId, 'job_id', 128),
          leaseGeneration: requireInteger(body.leaseGeneration, 'lease_generation', 1),
          materializerId,
          now: requestNow,
          proofJti: verifiedProof.jti,
          sha256: requireString(body.sha256, 'sha256', 64),
          traceId,
          verifiedProofKeyThumbprint: verifiedProof.thumbprint,
        });
      } else if (url.pathname === COMPLETE_PATH) {
        requireExactKeys(body, [
          'attributionRecords',
          'builds',
          'capability',
          'capabilityId',
          'jobId',
          'leaseGeneration',
          'materializerId',
          'outputFiles',
          'outputTreeRoot',
          'proof',
          'providerVersion',
          'writeIntentId',
        ]);
        const builds = requireObject(body.builds, 'builds');
        requireExactKeys(builds, ['codec', 'helper', 'runtime']);
        result = await config.broker.completeRendition({
          attributionRecords: parseAttributionRecords(body.attributionRecords),
          builds: {
            codec: requireString(builds.codec, 'codec_build'),
            helper: requireString(builds.helper, 'helper_build'),
            runtime: requireString(builds.runtime, 'runtime_build'),
          },
          capabilityId: requireString(body.capabilityId, 'capability_id', 128),
          coseSign1: Buffer.from(capability, 'base64url'),
          jobId: requireString(body.jobId, 'job_id', 128),
          leaseGeneration: requireInteger(body.leaseGeneration, 'lease_generation', 1),
          materializerId,
          now: requestNow,
          outputFiles: parseOutputFiles(body.outputFiles),
          outputTreeRoot: requireString(body.outputTreeRoot, 'output_tree_root', 64),
          proofJti: verifiedProof.jti,
          providerVersion: requireString(body.providerVersion, 'provider_version'),
          traceId,
          verifiedProofKeyThumbprint: verifiedProof.thumbprint,
          writeIntentId: requireString(body.writeIntentId, 'write_intent_id', 128),
        });
      } else {
        requireExactKeys(body, [
          'capability',
          'capabilityId',
          'errorCode',
          'jobId',
          'leaseGeneration',
          'materializerId',
          'proof',
        ]);
        await config.broker.failCapabilityJob({
          capabilityId: requireString(body.capabilityId, 'capability_id', 128),
          coseSign1: Buffer.from(capability, 'base64url'),
          errorCode: requireString(body.errorCode, 'error_code', 128),
          jobId: requireString(body.jobId, 'job_id', 128),
          leaseGeneration: requireInteger(body.leaseGeneration, 'lease_generation', 1),
          materializerId,
          now: requestNow,
          proofJti: verifiedProof.jti,
          verifiedProofKeyThumbprint: verifiedProof.thumbprint,
        });
        result = { status: 'failed' };
      }
      emit('accepted');
      return noStoreJson(result, 200, traceId);
    } catch (error) {
      if (error instanceof RequestBoundaryError) {
        emit('rejected', error.code);
        return noStoreJson({ error: error.code }, error.status, traceId);
      }
      if (tufRoute) {
        emit('rejected', 'package_installer_tuf_read_failed');
        return noStoreJson({ error: 'package_installer_tuf_read_failed' }, 503, traceId);
      }
      const errorCode =
        classifyMaterializationControlError(url.pathname, error) ??
        (url.pathname === CREATE_JOB_PATH
          ? 'materialization_job_rejected'
          : url.pathname === ATTRIBUTION_CANDIDATES_PATH
            ? 'materialization_attribution_lookup_rejected'
            : url.pathname === CLAIM_JOB_PATH
              ? 'materialization_claim_rejected'
              : url.pathname === RENEW_JOB_PATH
                ? 'materialization_renewal_rejected'
                : url.pathname === STATUS_JOB_PATH
                  ? 'materialization_status_rejected'
                  : url.pathname === FAIL_JOB_PATH
                    ? 'materialization_failure_rejected'
                    : url.pathname === CONSUME_PATH
                      ? 'capability_rejected'
                      : url.pathname === UPLOAD_TICKET_PATH
                        ? 'rendition_upload_rejected'
                        : 'rendition_completion_rejected');
      emit('rejected', errorCode);
      return noStoreJson({ error: errorCode }, 403, traceId);
    }
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function envBase64Url(name: string, expectedLength: number): Buffer {
  const value = requiredEnv(name);
  if (!BASE64URL.test(value)) {
    throw new Error(`${name} must use unpadded base64url`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.byteLength !== expectedLength) {
    throw new Error(`${name} has an invalid length`);
  }
  return bytes;
}

export const MATERIALIZATION_CONTROL_PLANE_INFISICAL_KEYS = [
  'METADATA_S3_ACCESS_KEY_ID',
  'METADATA_S3_BUCKET',
  'METADATA_S3_ENDPOINT',
  'METADATA_S3_REGION',
  'METADATA_S3_SECRET_ACCESS_KEY',
  'PACKAGE_INSTALLER_TUF_REPOSITORY_ID',
  'PACKAGE_CATALOG_DATABASE_URL',
  'RENDITION_S3_ACCESS_KEY_ID',
  'RENDITION_S3_BUCKET',
  'RENDITION_S3_ENDPOINT',
  'RENDITION_S3_REGION',
  'RENDITION_S3_SECRET_ACCESS_KEY',
  'MATERIALIZATION_KEY_BROKER_BASE_URL',
  'MATERIALIZATION_KEY_BROKER_SHARED_SECRET',
  'MATERIALIZATION_RECEIPT_KEY_ID',
  'MATERIALIZATION_RECEIPT_PRIVATE_KEY',
  'MATERIALIZATION_SOURCE_GRANT_AUDIENCE',
  'MATERIALIZATION_SOURCE_DELIVERY_BASE_URL',
  'MATERIALIZATION_SOURCE_GRANT_ISSUER',
  'MATERIALIZATION_SOURCE_GRANT_KEY_ID',
  'MATERIALIZATION_SOURCE_GRANT_PRIVATE_KEY',
  'MATERIALIZATION_API_SHARED_SECRET',
  'MATERIALIZATION_CAPABILITY_KEY_ID',
  'MATERIALIZATION_CAPABILITY_PRIVATE_KEY',
  'MATERIALIZATION_CAPABILITY_PUBLIC_KEY',
  'MATERIALIZATION_KEY_EPOCH',
  'MATERIALIZATION_ALGORITHM_VERSION',
  'MATERIALIZATION_MATERIALIZER_SHARED_SECRET',
  'MATERIALIZATION_PLUGIN_VERSION',
  'MATERIALIZATION_CONTROL_PLANE_PUBLIC_BASE_URL',
] as const;

async function main(): Promise<void> {
  const hydrated = await hydrateEnvFromInfisical(
    process.env,
    MATERIALIZATION_CONTROL_PLANE_INFISICAL_KEYS
  );
  for (const [key, value] of Object.entries(hydrated)) {
    if (typeof value === 'string') {
      process.env[key] = value;
    }
  }
  const sql = openCatalogDatabase(requiredEnv('PACKAGE_CATALOG_DATABASE_URL'));
  await runCatalogMigrations(sql);
  const renditionStorage = new S3RenditionStoragePort(
    loadCasConfig({
      CAS_S3_ACCESS_KEY_ID: requiredEnv('RENDITION_S3_ACCESS_KEY_ID'),
      CAS_S3_BUCKET: requiredEnv('RENDITION_S3_BUCKET'),
      CAS_S3_ENDPOINT: requiredEnv('RENDITION_S3_ENDPOINT'),
      CAS_S3_REGION: requiredEnv('RENDITION_S3_REGION'),
      CAS_S3_REQUEST_TIMEOUT_MS:
        process.env.RENDITION_S3_REQUEST_TIMEOUT_MS ?? process.env.CAS_S3_REQUEST_TIMEOUT_MS,
      CAS_S3_SECRET_ACCESS_KEY: requiredEnv('RENDITION_S3_SECRET_ACCESS_KEY'),
    })
  );
  const broker = new MaterializationBroker({
    keyBroker: createMaterializationKeyBrokerClient({
      baseUrl: requiredEnv('MATERIALIZATION_KEY_BROKER_BASE_URL'),
      sharedSecret: requiredEnv('MATERIALIZATION_KEY_BROKER_SHARED_SECRET'),
      timeoutMs: Number.parseInt(process.env.MATERIALIZATION_KEY_BROKER_TIMEOUT_MS ?? '10000', 10),
    }),
    receiptSigning: {
      keyId: packageContractKeyId(requiredEnv('MATERIALIZATION_RECEIPT_KEY_ID')),
      lifetimeSeconds: Number.parseInt(
        process.env.MATERIALIZATION_RECEIPT_LIFETIME_SECONDS ?? String(7 * 24 * 60 * 60),
        10
      ),
      privateKey: envBase64Url('MATERIALIZATION_RECEIPT_PRIVATE_KEY', 32),
    },
    renditionStorage,
    sourceGrant: {
      audience: requiredEnv('MATERIALIZATION_SOURCE_GRANT_AUDIENCE'),
      baseUrl: requiredEnv('MATERIALIZATION_SOURCE_DELIVERY_BASE_URL'),
      issuer: requiredEnv('MATERIALIZATION_SOURCE_GRANT_ISSUER'),
      keyId: packageContractKeyId(requiredEnv('MATERIALIZATION_SOURCE_GRANT_KEY_ID')),
      lifetimeSeconds: Number.parseInt(
        process.env.MATERIALIZATION_SOURCE_GRANT_LIFETIME_SECONDS ?? '300',
        10
      ),
      privateKey: envBase64Url('MATERIALIZATION_SOURCE_GRANT_PRIVATE_KEY', 32),
    },
    sql,
    storageGcPinRetentionSeconds: Number.parseInt(
      process.env.MATERIALIZATION_STORAGE_GC_PIN_RETENTION_SECONDS ??
        String(DEFAULT_MATERIALIZATION_STORAGE_GC_PIN_RETENTION_SECONDS),
      10
    ),
  });
  const handler = createMaterializationControlPlaneHandler({
    apiSharedSecret: requiredEnv('MATERIALIZATION_API_SHARED_SECRET'),
    broker,
    capabilityKeyId: packageContractKeyId(requiredEnv('MATERIALIZATION_CAPABILITY_KEY_ID')),
    capabilityLifetimeSeconds: Number.parseInt(
      process.env.MATERIALIZATION_CAPABILITY_LIFETIME_SECONDS ?? '300',
      10
    ),
    capabilityPrivateKey: envBase64Url('MATERIALIZATION_CAPABILITY_PRIVATE_KEY', 32),
    capabilityPublicKey: envBase64Url('MATERIALIZATION_CAPABILITY_PUBLIC_KEY', 32),
    keyEpoch: Number.parseInt(requiredEnv('MATERIALIZATION_KEY_EPOCH'), 10),
    materializationAlgorithm: requiredEnv('MATERIALIZATION_ALGORITHM_VERSION'),
    materializerSharedSecret: requiredEnv('MATERIALIZATION_MATERIALIZER_SHARED_SECRET'),
    onEvent: (event) => {
      console.log(JSON.stringify(event));
    },
    packageInstallerTufRepository: new ExactTufRepositoryReader({
      catalog: new TufRepositoryCatalog(sql),
      repositoryId: requiredEnv('PACKAGE_INSTALLER_TUF_REPOSITORY_ID'),
      storage: new S3ExactStoragePort({
        metadata: loadStorageRoleConfig(process.env, STORAGE_ROLE_PREFIXES.metadata),
      }),
    }),
    pluginVersion: requiredEnv('MATERIALIZATION_PLUGIN_VERSION'),
    publicBaseUrl: requiredEnv('MATERIALIZATION_CONTROL_PLANE_PUBLIC_BASE_URL'),
  });
  const port = Number.parseInt(process.env.MATERIALIZATION_CONTROL_PLANE_PORT ?? '3012', 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('MATERIALIZATION_CONTROL_PLANE_PORT is invalid');
  }
  const server = Bun.serve({
    fetch: handler,
    hostname: process.env.MATERIALIZATION_CONTROL_PLANE_HOST ?? '127.0.0.1',
    port,
  });
  console.log(
    JSON.stringify({
      event: 'materialization.control_plane.started',
      hostname: server.hostname,
      port: server.port,
    })
  );
  const shutdown = async () => {
    await server.stop();
    await sql.end({ timeout: 5 });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (import.meta.main) {
  main().catch(() => {
    console.error(
      JSON.stringify({
        errorCode: 'startup_failed',
        event: 'materialization.control_plane.failed',
      })
    );
    process.exitCode = 1;
  });
}
