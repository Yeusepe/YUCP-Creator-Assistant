import { createHash } from 'node:crypto';
import * as ed25519 from '@noble/ed25519';
import { verifyDpopProof } from '../../../../ops/storage-core/dpop';
import {
  packageContractKeyId,
  verifyDeliveryGrantV2,
} from '../../../../ops/storage-core/packageContractsV2';
import {
  issuePackageInstallSession,
  type PackageInstallPublication,
} from '../lib/packageInstallSessionIssuer';
import { RequestBodyError, readJsonObjectBodyWithLimit } from '../lib/requestBody';

const REQUEST_BODY_LIMIT_BYTES = 16 * 1024;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

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
  hasActiveEntitlement(
    buyerId: string,
    group: PackageInstallProductGroup,
    catalogProductId: string
  ): Promise<boolean>;
  resolveProductGroup(catalogProductIds: string[]): Promise<PackageInstallProductGroup | null>;
  resolvePublication(
    group: PackageInstallProductGroup,
    targetReleaseRoot?: string
  ): Promise<PackageInstallPublication | null>;
}

type AccessTokenResult = { buyerId: string; ok: true } | { ok: false; status: 401 | 403 };

export interface CreatePackageInstallSessionRouteOptions {
  accessPort: PackageInstallAccessPort;
  audience: string;
  issuer: string;
  keyId: string;
  materializationControl?: PackageInstallMaterializationJobControl;
  privateKey: Uint8Array;
  verifyAccessToken(token: string): Promise<AccessTokenResult>;
}

export interface PackageInstallMaterializationJobControl {
  createJob(input: {
    bindingRoot: string;
    buyerId: string;
    creatorId: string;
    grantJti: string;
    jobId: string;
    productId: string;
    protectedFiles: PackageInstallPublication['protectedFiles'];
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

type PackageInstallSessionRequest = {
  aliasId: string;
  catalogProductIds: string[];
  deviceKeyThumbprint: string;
  idempotencyKey: string;
  targetReleaseRoot?: string;
};

function jsonNoStore(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

function readBearerToken(request: Request): string | null {
  const match = request.headers
    .get('authorization')
    ?.trim()
    .match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
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

function normalizeRequestBody(body: Record<string, unknown>): PackageInstallSessionRequest {
  if (!Array.isArray(body.catalogProductIds)) {
    throw new RequestBodyError('catalogProductIds must be an array', 400);
  }
  if (body.catalogProductIds.length === 0 || body.catalogProductIds.length > 32) {
    throw new RequestBodyError('catalogProductIds must contain 1 through 32 identifiers', 400);
  }
  const catalogProductIds = Array.from(
    new Set(
      body.catalogProductIds.map((value, index) =>
        normalizeIdentifier(value, `catalogProductIds[${index}]`)
      )
    )
  ).sort((left, right) => left.localeCompare(right));
  if (catalogProductIds.length !== body.catalogProductIds.length) {
    throw new RequestBodyError('catalogProductIds must not contain duplicates', 400);
  }
  if (
    typeof body.deviceKeyThumbprint !== 'string' ||
    !SHA256_HEX_PATTERN.test(body.deviceKeyThumbprint)
  ) {
    throw new RequestBodyError('deviceKeyThumbprint must be a lowercase SHA-256 digest', 400);
  }
  return {
    aliasId: normalizeIdentifier(body.aliasId, 'aliasId'),
    catalogProductIds,
    deviceKeyThumbprint: body.deviceKeyThumbprint,
    idempotencyKey: normalizeIdentifier(body.idempotencyKey, 'idempotencyKey'),
    ...(body.targetReleaseRoot !== undefined
      ? {
          targetReleaseRoot:
            typeof body.targetReleaseRoot === 'string' &&
            SHA256_HEX_PATTERN.test(body.targetReleaseRoot)
              ? body.targetReleaseRoot
              : (() => {
                  throw new RequestBodyError(
                    'targetReleaseRoot must be a lowercase SHA-256 digest',
                    400
                  );
                })(),
        }
      : {}),
  };
}

function sameIdentifiers(left: string[], right: string[]): boolean {
  const normalizedLeft = [...left].sort((a, b) => a.localeCompare(b));
  const normalizedRight = [...right].sort((a, b) => a.localeCompare(b));
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
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

export function createPackageInstallSessionRoute(
  options: CreatePackageInstallSessionRouteOptions
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST') {
      return jsonNoStore({ error: 'Method not allowed' }, 405);
    }
    const bearerToken = readBearerToken(request);
    if (!bearerToken) {
      return jsonNoStore({ error: 'Authentication required' }, 401);
    }
    const authentication = await options.verifyAccessToken(bearerToken);
    if (!authentication.ok) {
      return jsonNoStore(
        {
          error:
            authentication.status === 403
              ? 'Token missing required scope'
              : 'Invalid or expired access token',
        },
        authentication.status
      );
    }

    let input: PackageInstallSessionRequest;
    try {
      input = normalizeRequestBody(
        await readJsonObjectBodyWithLimit(request, REQUEST_BODY_LIMIT_BYTES)
      );
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return jsonNoStore({ error: error.message }, error.status);
      }
      throw error;
    }

    const group = await options.accessPort.resolveProductGroup(input.catalogProductIds);
    if (
      !group ||
      group.aliasId !== input.aliasId ||
      !sameIdentifiers(group.catalogProductIds, input.catalogProductIds)
    ) {
      return jsonNoStore({ error: 'Package alias not found' }, 404);
    }

    let entitled = false;
    for (const catalogProductId of group.catalogProductIds) {
      if (
        await options.accessPort.hasActiveEntitlement(
          authentication.buyerId,
          group,
          catalogProductId
        )
      ) {
        entitled = true;
        break;
      }
    }
    if (!entitled) {
      return jsonNoStore({ error: 'Active entitlement required' }, 403);
    }

    const publication = await options.accessPort.resolvePublication(group, input.targetReleaseRoot);
    if (!publication) {
      return jsonNoStore({ error: 'Product is not yet published' }, 404);
    }
    const protectedPublication = publication.protectedFiles.length > 0;
    if (protectedPublication && !options.materializationControl) {
      return jsonNoStore({ error: 'Protected materialization is not configured' }, 503);
    }
    const identityFields = [
      authentication.buyerId,
      input.aliasId,
      input.deviceKeyThumbprint,
      input.idempotencyKey,
      publication.versionId,
      publication.releaseRoot,
    ];
    const sessionId = deterministicInstallIdentifier('session', identityFields);
    const deliveryGrantId = deterministicInstallIdentifier('grant', identityFields);
    const materializationJobId = protectedPublication
      ? deterministicInstallIdentifier('job', identityFields)
      : undefined;
    const issued = await issuePackageInstallSession({
      audience: options.audience,
      buyerId: authentication.buyerId,
      deliveryGrantId,
      deviceKeyThumbprint: input.deviceKeyThumbprint,
      issuer: options.issuer,
      keyId: options.keyId,
      ...(materializationJobId ? { materializationJobId } : {}),
      now: Math.floor(Date.now() / 1000),
      privateKey: options.privateKey,
      publication,
      sessionId,
    });
    if (materializationJobId && options.materializationControl) {
      const traceparent = request.headers.get('traceparent');
      try {
        await options.materializationControl.createJob({
          bindingRoot: publication.bindingRoot,
          buyerId: authentication.buyerId,
          creatorId: publication.creatorId,
          grantJti: issued.deliveryGrantId,
          jobId: materializationJobId,
          productId: publication.packageId,
          protectedFiles: publication.protectedFiles,
          protectedSourceRoot: publication.protectedSourceRoot,
          releaseRoot: publication.releaseRoot,
          sourceLogicalBytes: publication.logicalBytes,
          sourceLogicalFiles: publication.logicalFiles,
          sourceManifestSha256: publication.manifestSha256,
          sourceVersionId: publication.versionId,
          ...(traceparent && TRACEPARENT_PATTERN.test(traceparent) ? { traceparent } : {}),
        });
      } catch {
        return jsonNoStore({ error: 'Protected materialization job could not be created' }, 503);
      }
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
