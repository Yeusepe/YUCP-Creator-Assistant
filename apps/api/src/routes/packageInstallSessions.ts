import { createHash, randomBytes } from 'node:crypto';
import * as ed25519 from '@noble/ed25519';
import { parseTraceparent } from '@yucp/shared';
import { verifyDpopProof } from '../../../../ops/storage-core/dpop';
import {
  encodePackageOperationCapabilityV2,
  type InstallSessionOperation,
  PACKAGE_CONTRACT_PURPOSES,
  PACKAGE_OPERATION_CAPABILITY_MAX_LIFETIME_SECONDS,
  packageContractKeyId,
  signPackageContract,
  verifyDeliveryGrantV2,
  verifyPackageOperationCapabilityV2,
} from '../../../../ops/storage-core/packageContractsV2';
import {
  INSTALL_SESSION_LIFETIME_SECONDS,
  issuePackageInstallSession,
  type PackageInstallPublication,
} from '../lib/packageInstallSessionIssuer';
import { RequestBodyError, readJsonObjectBodyWithLimit } from '../lib/requestBody';

const REQUEST_BODY_LIMIT_BYTES = 16 * 1024;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const DELIVERY_PIN_SAFETY_MARGIN_SECONDS = 60;
const PACKAGE_OPERATION_FIELDS = new Set([
  'aliasId',
  'approvedActiveContentDigest',
  'approvedPolicyVersion',
  'expectedCurrentReleaseRoot',
  'idempotencyKey',
  'operation',
  'projectIdentity',
  'targetReleaseRoot',
  'traceparent',
]);

export interface PackageInstallStorefront {
  catalogProductId: string;
  productId: string;
}

export interface PackageInstallProductGroup {
  aliasId: string;
  catalogProductIds: string[];
  creatorId: string;
  packageId: string;
  storefronts: PackageInstallStorefront[];
}

export interface PackageInstallAccessPort {
  resolveEntitledEdition(
    buyerId: string,
    group: PackageInstallProductGroup
  ): Promise<string | null>;
  resolveProductGroup(aliasId: string): Promise<PackageInstallProductGroup | null>;
  resolvePublication(
    group: PackageInstallProductGroup,
    editionId: string,
    targetReleaseRoot?: string
  ): Promise<PackageInstallPublication | null>;
}

type AccessRequestResult =
  | { buyerId: string; deviceKeyThumbprint: string; ok: true }
  | { ok: false; status: 401 | 403 };

export interface PackageOperationAuthorizationPort {
  beginExchange(input: {
    buyerId: string;
    capabilityId: string;
    deviceKeyThumbprint: string;
    tokenSha256: string;
  }): Promise<
    | { generation: number; status: 'claimed' }
    | { status: 'in_progress' | 'invalid' }
    | {
        deliveryGrantId: string;
        materializationJobId?: string;
        sessionId: string;
        status: 'ready';
        versionId: string;
      }
  >;
  completeExchange(input: {
    capabilityId: string;
    deliveryGrantId: string;
    generation: number;
    materializationJobId?: string;
    sessionId: string;
    versionId: string;
  }): Promise<boolean>;
  releaseExchange(input: { capabilityId: string; generation: number }): Promise<boolean>;
  reserve(input: {
    aliasId: string;
    approvedActiveContentDigest?: string;
    approvedPolicyVersion?: string;
    buyerId: string;
    capabilityId: string;
    consumedAt?: Date;
    deviceKeyThumbprint: string;
    expectedCurrentReleaseRoot: string;
    expiresAt: Date;
    idempotencyKey: string;
    issuedAt: Date;
    oneUseNonce: string;
    operation: InstallSessionOperation;
    projectIdentity: string;
    releaseRoot: string;
    tokenSha256: string;
    traceparent: string;
  }): Promise<{
    record: {
      aliasId: string;
      approvedActiveContentDigest?: string;
      approvedPolicyVersion?: string;
      buyerId: string;
      capabilityId: string;
      consumedAt?: Date;
      deviceKeyThumbprint: string;
      expectedCurrentReleaseRoot: string;
      expiresAt: Date;
      idempotencyKey: string;
      issuedAt: Date;
      oneUseNonce: string;
      operation: InstallSessionOperation;
      projectIdentity: string;
      releaseRoot: string;
      tokenSha256: string;
      traceparent: string;
    };
    status: 'consumed' | 'conflict' | 'created' | 'existing';
  }>;
}

export interface CreatePackageInstallSessionRouteOptions {
  accessPort: PackageInstallAccessPort;
  authorizationPort: PackageOperationAuthorizationPort;
  audience: string;
  issuer: string;
  keyId: string;
  materializationControl?: PackageInstallMaterializationJobControl;
  privateKey: Uint8Array;
  releasePins?: PackageInstallReleasePinControl;
  verificationBaseUrl: string;
  verifyAccessRequest(request: Request): Promise<AccessRequestResult>;
}

export interface PackageInstallReleasePinControl {
  acquireReleasePin(input: {
    expiresAt: string;
    ownerId: string;
    packageVersionId: string;
    pinKind: 'delivery-binding';
  }): Promise<{ pinId: string }>;
  releaseReleasePin(input: { pinId: string }): Promise<void>;
}

export interface PackageInstallMaterializationJobControl {
  createJob(input: {
    bindingRoot: string;
    buyerId: string;
    creatorId: string;
    grantJti: string;
    jobId: string;
    productId: string;
    protectedSourceRoot: string;
    releaseRoot: string;
    sourceLogicalBytes: number;
    sourceLogicalFiles: number;
    sourceManifestSha256: string;
    sourceVersionId: string;
    traceparent?: string;
  }): Promise<void>;
}

export interface PackageInstallMaterializationStatusControl {
  getStatus(input: { grantJti: string; jobId: string }): Promise<
    | {
        queuePosition: number;
        state: 'MATERIALIZING' | 'QUEUED' | 'VERIFYING';
        status: 'pending';
      }
    | { errorCode: string; status: 'failed' }
    | { receipt: string; receiptId: string; status: 'succeeded' }
  >;
}

export interface PackageInstallMaterializationControl
  extends PackageInstallMaterializationJobControl,
    PackageInstallMaterializationStatusControl {}

type PackageOperationRequest = {
  aliasId: string;
  approvedActiveContentDigest?: string;
  approvedPolicyVersion?: string;
  expectedCurrentReleaseRoot: string;
  idempotencyKey: string;
  operation: InstallSessionOperation;
  projectIdentity: string;
  targetReleaseRoot?: string;
  traceparent: string;
};

type PackageInstallSessionRequest = PackageOperationRequest & {
  operationCapability: string;
};

function jsonNoStore(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

function hasDpopAuthorization(request: Request): boolean {
  return (
    /^DPoP\s+\S+$/.test(request.headers.get('authorization')?.trim() ?? '') &&
    Boolean(request.headers.get('dpop')?.trim())
  );
}

function normalizeIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new RequestBodyError(`${name} must be a string`, 400);
  }
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized)) {
    throw new RequestBodyError(`${name} is invalid`, 400);
  }
  return normalized;
}

function optionalDigest(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value)) {
    throw new RequestBodyError(`${name} must be a lowercase SHA-256 digest`, 400);
  }
  return value;
}

function normalizeOperationBody(
  body: Record<string, unknown>,
  includeCapability = false
): PackageOperationRequest {
  const allowedFields = includeCapability
    ? new Set([...PACKAGE_OPERATION_FIELDS, 'operationCapability'])
    : PACKAGE_OPERATION_FIELDS;
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    throw new RequestBodyError('Request fields are invalid', 400);
  }
  if (
    body.operation !== 'install' &&
    body.operation !== 'preflight' &&
    body.operation !== 'recover' &&
    body.operation !== 'repair' &&
    body.operation !== 'rollback' &&
    body.operation !== 'uninstall' &&
    body.operation !== 'update'
  ) {
    throw new RequestBodyError('operation is invalid', 400);
  }
  if (typeof body.traceparent !== 'string' || !parseTraceparent(body.traceparent)) {
    throw new RequestBodyError('traceparent is invalid', 400);
  }
  const approvedActiveContentDigest = optionalDigest(
    body.approvedActiveContentDigest,
    'approvedActiveContentDigest'
  );
  const approvedPolicyVersion =
    body.approvedPolicyVersion === undefined
      ? undefined
      : normalizeIdentifier(body.approvedPolicyVersion, 'approvedPolicyVersion');
  const expectedCurrentReleaseRoot = optionalDigest(
    body.expectedCurrentReleaseRoot,
    'expectedCurrentReleaseRoot'
  );
  if (!expectedCurrentReleaseRoot) {
    throw new RequestBodyError('expectedCurrentReleaseRoot is required', 400);
  }
  if (body.operation === 'preflight') {
    if (approvedActiveContentDigest || approvedPolicyVersion) {
      throw new RequestBodyError('preflight must not include content approval', 400);
    }
  } else if (!approvedActiveContentDigest || !approvedPolicyVersion) {
    throw new RequestBodyError(
      'approvedActiveContentDigest and approvedPolicyVersion are required',
      400
    );
  }
  return {
    aliasId: normalizeIdentifier(body.aliasId, 'aliasId'),
    ...(approvedActiveContentDigest ? { approvedActiveContentDigest } : {}),
    ...(approvedPolicyVersion ? { approvedPolicyVersion } : {}),
    expectedCurrentReleaseRoot,
    idempotencyKey: normalizeIdentifier(body.idempotencyKey, 'idempotencyKey'),
    operation: body.operation,
    projectIdentity:
      optionalDigest(body.projectIdentity, 'projectIdentity') ??
      (() => {
        throw new RequestBodyError('projectIdentity is required', 400);
      })(),
    ...(optionalDigest(body.targetReleaseRoot, 'targetReleaseRoot')
      ? { targetReleaseRoot: body.targetReleaseRoot as string }
      : {}),
    traceparent: body.traceparent,
  };
}

function normalizeSessionBody(body: Record<string, unknown>): PackageInstallSessionRequest {
  if (
    typeof body.operationCapability !== 'string' ||
    body.operationCapability.length === 0 ||
    body.operationCapability.length > 256 * 1024 ||
    !/^[A-Za-z0-9_-]+$/.test(body.operationCapability)
  ) {
    throw new RequestBodyError('operationCapability must use bounded unpadded base64url', 400);
  }
  return {
    ...normalizeOperationBody(body, true),
    operationCapability: body.operationCapability,
  };
}

function requireVerificationOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('verificationBaseUrl must be an absolute HTTPS or loopback HTTP origin');
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (
    (url.protocol !== 'https:' && !loopbackHttp) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('verificationBaseUrl must be an absolute HTTPS or loopback HTTP origin');
  }
  return url.origin;
}

function deterministicInstallIdentifier(
  prefix: 'grant' | 'job' | 'session',
  fields: readonly string[]
): string {
  const digest = createHash('sha256');
  digest.update(`yucp:package-install:${prefix}:v2\0`, 'utf8');
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    digest.update(length);
    digest.update(bytes);
  }
  return `${prefix}-${digest.digest('hex').slice(0, 48)}`;
}

async function requireDpopAccess(
  request: Request,
  options: Pick<CreatePackageInstallSessionRouteOptions, 'verifyAccessRequest'>
): Promise<AccessRequestResult> {
  if (!hasDpopAuthorization(request)) {
    return { ok: false, status: 401 };
  }
  return options.verifyAccessRequest(request);
}

async function resolveAuthorizedPublication(input: {
  accessPort: PackageInstallAccessPort;
  buyerId: string;
  operation: PackageOperationRequest;
  verificationOrigin: string;
}): Promise<
  | { group: PackageInstallProductGroup; publication: PackageInstallPublication }
  | { response: Response }
> {
  const group = await input.accessPort.resolveProductGroup(input.operation.aliasId);
  if (!group || group.aliasId !== input.operation.aliasId) {
    return { response: jsonNoStore({ error: 'Package alias not found' }, 404) };
  }
  const entitledEditionId = await input.accessPort.resolveEntitledEdition(input.buyerId, group);
  if (!entitledEditionId) {
    const verificationCatalogProductId = group.catalogProductIds[0];
    if (!verificationCatalogProductId) {
      return { response: jsonNoStore({ error: 'Package alias not found' }, 404) };
    }
    return {
      response: jsonNoStore(
        {
          errorCode: 'ENTITLEMENT_REQUIRED',
          verificationUrl: `${input.verificationOrigin}/access/${encodeURIComponent(
            verificationCatalogProductId
          )}`,
        },
        403
      ),
    };
  }
  const publication = await input.accessPort.resolvePublication(
    group,
    entitledEditionId,
    input.operation.targetReleaseRoot
  );
  if (!publication) {
    return { response: jsonNoStore({ error: 'Product is not yet published' }, 404) };
  }
  if (
    input.operation.operation !== 'preflight' &&
    (input.operation.approvedActiveContentDigest !== publication.activeContentDigest ||
      input.operation.approvedPolicyVersion !== publication.activePolicyVersion)
  ) {
    return {
      response: jsonNoStore(
        {
          error: 'Approved package content is stale',
          errorCode: 'STALE_CONTENT_APPROVAL',
        },
        409
      ),
    };
  }
  return { group, publication };
}

function operationCapabilityFromRecord(
  record: Awaited<ReturnType<PackageOperationAuthorizationPort['reserve']>>['record'],
  issuer: string
) {
  return {
    aliasId: record.aliasId,
    audience: issuer,
    buyerId: record.buyerId,
    capabilityId: record.capabilityId,
    deviceKeyThumbprint: Uint8Array.from(Buffer.from(record.deviceKeyThumbprint, 'hex')),
    expiresAt: Math.floor(record.expiresAt.getTime() / 1_000),
    idempotencyKey: record.idempotencyKey,
    issuedAt: Math.floor(record.issuedAt.getTime() / 1_000),
    issuer,
    notBefore: Math.floor(record.issuedAt.getTime() / 1_000),
    oneUseNonce: Uint8Array.from(Buffer.from(record.oneUseNonce, 'hex')),
    operation: record.operation,
    projectIdentity: Uint8Array.from(Buffer.from(record.projectIdentity, 'hex')),
    releaseRoot: Uint8Array.from(Buffer.from(record.releaseRoot, 'hex')),
    traceparent: record.traceparent,
    expectedCurrentReleaseRoot: Uint8Array.from(
      Buffer.from(record.expectedCurrentReleaseRoot, 'hex')
    ),
    ...(record.approvedActiveContentDigest
      ? {
          approvedActiveContentDigest: Uint8Array.from(
            Buffer.from(record.approvedActiveContentDigest, 'hex')
          ),
        }
      : {}),
    ...(record.approvedPolicyVersion
      ? { approvedPolicyVersion: record.approvedPolicyVersion }
      : {}),
  };
}

async function signOperationCapability(input: {
  issuer: string;
  keyId: string;
  privateKey: Uint8Array;
  record: Awaited<ReturnType<PackageOperationAuthorizationPort['reserve']>>['record'];
}): Promise<Uint8Array> {
  const signed = await signPackageContract({
    keyId: packageContractKeyId(input.keyId),
    payload: encodePackageOperationCapabilityV2(
      operationCapabilityFromRecord(input.record, input.issuer)
    ),
    privateKey: input.privateKey,
    purpose: PACKAGE_CONTRACT_PURPOSES.packageOperationCapability,
  });
  return signed.coseSign1;
}

export function createPackageOperationAuthorizationRoute(
  options: CreatePackageInstallSessionRouteOptions
): (request: Request) => Promise<Response> {
  const verificationOrigin = requireVerificationOrigin(options.verificationBaseUrl);
  return async (request) => {
    if (request.method !== 'POST') {
      return jsonNoStore({ error: 'Method not allowed' }, 405);
    }
    const authentication = await requireDpopAccess(request, options);
    if (!authentication.ok) {
      return jsonNoStore(
        {
          error:
            authentication.status === 403
              ? 'Token missing required scope'
              : 'Invalid or expired DPoP authorization',
        },
        authentication.status
      );
    }
    let operation: PackageOperationRequest;
    try {
      operation = normalizeOperationBody(
        await readJsonObjectBodyWithLimit(request, REQUEST_BODY_LIMIT_BYTES)
      );
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return jsonNoStore({ error: error.message }, error.status);
      }
      throw error;
    }
    const resolved = await resolveAuthorizedPublication({
      accessPort: options.accessPort,
      buyerId: authentication.buyerId,
      operation,
      verificationOrigin,
    });
    if ('response' in resolved) {
      return resolved.response;
    }
    const issuedAtSeconds = Math.floor(Date.now() / 1_000);
    const requestedRecord = {
      aliasId: operation.aliasId,
      buyerId: authentication.buyerId,
      capabilityId: `operation-${randomBytes(24).toString('hex')}`,
      deviceKeyThumbprint: authentication.deviceKeyThumbprint,
      expiresAt: new Date(
        (issuedAtSeconds + PACKAGE_OPERATION_CAPABILITY_MAX_LIFETIME_SECONDS) * 1_000
      ),
      idempotencyKey: operation.idempotencyKey,
      issuedAt: new Date(issuedAtSeconds * 1_000),
      oneUseNonce: randomBytes(32).toString('hex'),
      operation: operation.operation,
      projectIdentity: operation.projectIdentity,
      releaseRoot: resolved.publication.releaseRoot,
      tokenSha256: '0'.repeat(64),
      traceparent: operation.traceparent,
      ...(operation.approvedActiveContentDigest
        ? { approvedActiveContentDigest: operation.approvedActiveContentDigest }
        : {}),
      ...(operation.approvedPolicyVersion
        ? { approvedPolicyVersion: operation.approvedPolicyVersion }
        : {}),
      expectedCurrentReleaseRoot: operation.expectedCurrentReleaseRoot,
    };
    const candidateToken = await signOperationCapability({
      issuer: options.issuer,
      keyId: options.keyId,
      privateKey: options.privateKey,
      record: requestedRecord,
    });
    requestedRecord.tokenSha256 = createHash('sha256').update(candidateToken).digest('hex');
    const reservation = await options.authorizationPort.reserve(requestedRecord);
    if (reservation.status === 'conflict' || reservation.status === 'consumed') {
      return jsonNoStore(
        {
          error: 'Package operation idempotency key is unavailable',
          errorCode: 'OPERATION_AUTHORIZATION_CONFLICT',
        },
        409
      );
    }
    const operationCapability = await signOperationCapability({
      issuer: options.issuer,
      keyId: options.keyId,
      privateKey: options.privateKey,
      record: reservation.record,
    });
    const tokenSha256 = createHash('sha256').update(operationCapability).digest('hex');
    if (tokenSha256 !== reservation.record.tokenSha256) {
      throw new Error('Persisted package operation authorization token digest is invalid');
    }
    return jsonNoStore(
      {
        expiresAt: reservation.record.expiresAt.toISOString(),
        operationCapability: Buffer.from(operationCapability).toString('base64url'),
        releaseRoot: reservation.record.releaseRoot,
      },
      reservation.status === 'created' ? 201 : 200
    );
  };
}

export function createPackageInstallSessionRoute(
  options: CreatePackageInstallSessionRouteOptions
): (request: Request) => Promise<Response> {
  const verificationOrigin = requireVerificationOrigin(options.verificationBaseUrl);
  const publicKey = ed25519.getPublicKeyAsync(options.privateKey);
  const expectedKeyId = packageContractKeyId(options.keyId);
  return async (request) => {
    if (request.method !== 'POST') {
      return jsonNoStore({ error: 'Method not allowed' }, 405);
    }
    const authentication = await requireDpopAccess(request, options);
    if (!authentication.ok) {
      return jsonNoStore(
        {
          error:
            authentication.status === 403
              ? 'Token missing required scope'
              : 'Invalid or expired DPoP authorization',
        },
        authentication.status
      );
    }

    let input: PackageInstallSessionRequest;
    try {
      input = normalizeSessionBody(
        await readJsonObjectBodyWithLimit(request, REQUEST_BODY_LIMIT_BYTES)
      );
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return jsonNoStore({ error: error.message }, error.status);
      }
      throw error;
    }

    if (!input.targetReleaseRoot) {
      return jsonNoStore({ error: 'targetReleaseRoot is required' }, 400);
    }
    let operationCapabilityBytes: Uint8Array;
    try {
      operationCapabilityBytes = Uint8Array.from(
        Buffer.from(input.operationCapability, 'base64url')
      );
      if (
        operationCapabilityBytes.byteLength === 0 ||
        Buffer.from(operationCapabilityBytes).toString('base64url') !== input.operationCapability
      ) {
        throw new Error('noncanonical operation capability');
      }
    } catch {
      return jsonNoStore({ error: 'Operation capability is invalid' }, 400);
    }
    const resolved = await resolveAuthorizedPublication({
      accessPort: options.accessPort,
      buyerId: authentication.buyerId,
      operation: input,
      verificationOrigin,
    });
    if ('response' in resolved) {
      return resolved.response;
    }
    const { publication } = resolved;
    let capability: Awaited<ReturnType<typeof verifyPackageOperationCapabilityV2>>;
    try {
      capability = await verifyPackageOperationCapabilityV2({
        context: {
          aliasId: input.aliasId,
          ...(input.approvedActiveContentDigest
            ? {
                approvedActiveContentDigest: Uint8Array.from(
                  Buffer.from(input.approvedActiveContentDigest, 'hex')
                ),
              }
            : {}),
          ...(input.approvedPolicyVersion
            ? { approvedPolicyVersion: input.approvedPolicyVersion }
            : {}),
          audience: options.issuer,
          deviceKeyThumbprint: Uint8Array.from(
            Buffer.from(authentication.deviceKeyThumbprint, 'hex')
          ),
          expectedCurrentReleaseRoot: Uint8Array.from(
            Buffer.from(input.expectedCurrentReleaseRoot, 'hex')
          ),
          idempotencyKey: input.idempotencyKey,
          issuer: options.issuer,
          now: Math.floor(Date.now() / 1_000),
          operation: input.operation,
          projectIdentity: Uint8Array.from(Buffer.from(input.projectIdentity, 'hex')),
          releaseRoot: Uint8Array.from(Buffer.from(input.targetReleaseRoot, 'hex')),
          traceparent: input.traceparent,
        },
        coseSign1: operationCapabilityBytes,
        expectedKeyId,
        publicKey: await publicKey,
      });
    } catch {
      return jsonNoStore(
        {
          error: 'Operation authorization is invalid or expired',
          errorCode: 'OPERATION_AUTHORIZATION_INVALID',
        },
        403
      );
    }
    if (
      capability.buyerId !== authentication.buyerId ||
      input.targetReleaseRoot !== publication.releaseRoot
    ) {
      return jsonNoStore(
        {
          error: 'Operation authorization is not bound to this request',
          errorCode: 'OPERATION_AUTHORIZATION_INVALID',
        },
        403
      );
    }
    const protectedPublication = publication.protectedFiles.length > 0;
    const requiresMaterialization =
      protectedPublication && input.operation !== 'preflight' && input.operation !== 'uninstall';
    if (requiresMaterialization && !options.materializationControl) {
      return jsonNoStore({ error: 'Protected materialization is not configured' }, 503);
    }
    if (!requiresMaterialization && !options.releasePins) {
      return jsonNoStore({ error: 'Package delivery retention is not configured' }, 503);
    }
    const identityFields = [
      authentication.buyerId,
      input.aliasId,
      authentication.deviceKeyThumbprint,
      input.idempotencyKey,
      input.operation,
      publication.versionId,
      publication.releaseRoot,
    ];
    const sessionId = deterministicInstallIdentifier('session', identityFields);
    const deliveryGrantId = deterministicInstallIdentifier('grant', identityFields);
    const materializationJobId = requiresMaterialization
      ? deterministicInstallIdentifier('job', identityFields)
      : undefined;
    const issuedAt = capability.issuedAt;
    let issued: Awaited<ReturnType<typeof issuePackageInstallSession>>;
    try {
      issued = await issuePackageInstallSession({
        audience: options.audience,
        buyerId: authentication.buyerId,
        deliveryGrantId,
        deviceKeyThumbprint: authentication.deviceKeyThumbprint,
        issuer: options.issuer,
        keyId: options.keyId,
        ...(materializationJobId ? { materializationJobId } : {}),
        now: issuedAt,
        operation: input.operation,
        privateKey: options.privateKey,
        publication,
        sessionId,
      });
    } catch {
      return jsonNoStore({ error: 'Package delivery authorization could not be issued' }, 503);
    }
    const exchange = await options.authorizationPort.beginExchange({
      buyerId: authentication.buyerId,
      capabilityId: capability.capabilityId,
      deviceKeyThumbprint: authentication.deviceKeyThumbprint,
      tokenSha256: createHash('sha256').update(operationCapabilityBytes).digest('hex'),
    });
    if (exchange.status === 'invalid') {
      return jsonNoStore(
        {
          error: 'Operation authorization was already used or expired',
          errorCode: 'OPERATION_AUTHORIZATION_REPLAYED',
        },
        409
      );
    }
    if (exchange.status === 'in_progress') {
      return jsonNoStore(
        {
          error: 'Package operation authorization is already processing',
          errorCode: 'OPERATION_AUTHORIZATION_IN_PROGRESS',
        },
        409
      );
    }
    if (
      exchange.status === 'ready' &&
      (exchange.sessionId !== sessionId ||
        exchange.deliveryGrantId !== deliveryGrantId ||
        exchange.materializationJobId !== materializationJobId ||
        exchange.versionId !== publication.versionId)
    ) {
      return jsonNoStore({ error: 'Persisted package operation outcome is invalid' }, 500);
    }
    let deliveryPinId: string | undefined;
    if (exchange.status === 'claimed' && !materializationJobId && options.releasePins) {
      try {
        const pin = await options.releasePins.acquireReleasePin({
          expiresAt: new Date(
            (issuedAt + INSTALL_SESSION_LIFETIME_SECONDS + DELIVERY_PIN_SAFETY_MARGIN_SECONDS) *
              1_000
          ).toISOString(),
          ownerId: sessionId,
          packageVersionId: publication.versionId,
          pinKind: 'delivery-binding',
        });
        deliveryPinId = pin.pinId;
      } catch {
        await options.authorizationPort.releaseExchange({
          capabilityId: capability.capabilityId,
          generation: exchange.generation,
        });
        return jsonNoStore({ error: 'Package delivery retention could not be reserved' }, 503);
      }
    }
    if (exchange.status === 'claimed' && materializationJobId && options.materializationControl) {
      try {
        await options.materializationControl.createJob({
          bindingRoot: publication.bindingRoot,
          buyerId: authentication.buyerId,
          creatorId: publication.creatorId,
          grantJti: issued.deliveryGrantId,
          jobId: materializationJobId,
          productId: publication.packageId,
          protectedSourceRoot: publication.protectedSourceRoot,
          releaseRoot: publication.releaseRoot,
          sourceLogicalBytes: publication.logicalBytes,
          sourceLogicalFiles: publication.logicalFiles,
          sourceManifestSha256: publication.manifestSha256,
          sourceVersionId: publication.versionId,
          traceparent: input.traceparent,
        });
      } catch {
        await options.authorizationPort.releaseExchange({
          capabilityId: capability.capabilityId,
          generation: exchange.generation,
        });
        return jsonNoStore({ error: 'Protected materialization job could not be created' }, 503);
      }
    }
    if (
      exchange.status === 'claimed' &&
      !(await options.authorizationPort.completeExchange({
        capabilityId: capability.capabilityId,
        deliveryGrantId,
        generation: exchange.generation,
        ...(materializationJobId ? { materializationJobId } : {}),
        sessionId,
        versionId: publication.versionId,
      }))
    ) {
      if (deliveryPinId && options.releasePins) {
        await options.releasePins.releaseReleasePin({ pinId: deliveryPinId });
      }
      await options.authorizationPort.releaseExchange({
        capabilityId: capability.capabilityId,
        generation: exchange.generation,
      });
      return jsonNoStore({ error: 'Package operation outcome could not be persisted' }, 503);
    }
    return jsonNoStore({
      deliveryGrant: Buffer.from(issued.deliveryGrant).toString('base64url'),
      deliveryGrantPurpose: issued.deliveryGrantPurpose,
      installSession: Buffer.from(issued.installSession).toString('base64url'),
      installSessionPurpose: issued.installSessionPurpose,
      releaseRoot: publication.releaseRoot,
      versionId: issued.versionId,
      ...(materializationJobId ? { materializationJobId } : {}),
    });
  };
}

export function createPackageMaterializationStatusRoute(options: {
  audience: string;
  issuer: string;
  keyId: string;
  materializationControl: PackageInstallMaterializationStatusControl;
  privateKey: Uint8Array;
}): (request: Request) => Promise<Response> {
  const publicKey = ed25519.getPublicKeyAsync(options.privateKey);
  const expectedKeyId = packageContractKeyId(options.keyId);
  return async (request) => {
    if (request.method !== 'POST') {
      return jsonNoStore({ error: 'Method not allowed' }, 405);
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonObjectBodyWithLimit(request, REQUEST_BODY_LIMIT_BYTES);
      if (Object.keys(body).sort().join(',') !== 'deliveryGrant,jobId,proof') {
        throw new RequestBodyError('Request fields are invalid', 400);
      }
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return jsonNoStore({ error: error.message }, error.status);
      }
      throw error;
    }
    const deliveryGrant = typeof body.deliveryGrant === 'string' ? body.deliveryGrant.trim() : '';
    const proof = typeof body.proof === 'string' ? body.proof.trim() : '';
    let jobId: string;
    try {
      jobId = normalizeIdentifier(body.jobId, 'jobId');
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return jsonNoStore({ error: error.message }, error.status);
      }
      throw error;
    }
    if (
      !deliveryGrant ||
      deliveryGrant.length > 256 * 1024 ||
      !/^[A-Za-z0-9_-]+$/.test(deliveryGrant) ||
      !proof ||
      proof.length > 8_192 ||
      proof.split('.').length !== 3
    ) {
      return jsonNoStore({ error: 'Signed materialization proof is invalid' }, 400);
    }
    let grantId: string;
    try {
      const verifiedProof = await verifyDpopProof({
        accessToken: deliveryGrant,
        method: 'POST',
        now: new Date(),
        proof,
        url: request.url,
      });
      const grant = await verifyDeliveryGrantV2({
        context: {
          audience: options.audience,
          deviceKeyThumbprint: verifiedProof.thumbprint,
          issuer: options.issuer,
          now: Math.floor(Date.now() / 1_000),
          requiredScope: `materialization:${jobId}:read`,
        },
        coseSign1: Buffer.from(deliveryGrant, 'base64url'),
        expectedKeyId,
        publicKey: await publicKey,
      });
      grantId = grant.grantId;
    } catch {
      return jsonNoStore({ error: 'Materialization authorization failed' }, 403);
    }
    try {
      return jsonNoStore(
        await options.materializationControl.getStatus({
          grantJti: grantId,
          jobId,
        })
      );
    } catch {
      return jsonNoStore({ error: 'Materialization status is unavailable' }, 503);
    }
  };
}
