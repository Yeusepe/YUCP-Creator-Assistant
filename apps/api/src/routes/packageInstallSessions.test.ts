import { describe, expect, mock, test } from 'bun:test';
import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import * as ed25519 from '@noble/ed25519';
import {
  verifyDeliveryGrantV2,
  verifyInstallSessionV2,
} from '../../../../ops/storage-core/packageContractsV2';
import { issuePackageInstallSession } from '../lib/packageInstallSessionIssuer';
import {
  createPackageInstallSessionRoute,
  createPackageMaterializationStatusRoute,
  type PackageInstallAccessPort,
  type PackageInstallProductGroup,
} from './packageInstallSessions';

const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const publicKey = await ed25519.getPublicKeyAsync(privateKey);
const issuer = 'https://api.example.test';
const audience = 'https://delivery.example.test';
const keyId = 'install-session-test-1';
const deviceKeyThumbprint = '44'.repeat(32);

function productGroup(): PackageInstallProductGroup {
  return {
    aliasId: 'jammr',
    catalogProductIds: ['catalog-jammr-gumroad', 'catalog-jammr-jinxxy'],
    creatorId: 'creator-1',
    packageId: 'com.yucp.jammr',
    storefronts: [
      { catalogProductId: 'catalog-jammr-gumroad', productId: 'gumroad-product' },
      { catalogProductId: 'catalog-jammr-jinxxy', productId: 'jinxxy-product' },
    ],
  };
}

function accessPort(overrides: Partial<PackageInstallAccessPort> = {}): PackageInstallAccessPort {
  return {
    resolveProductGroup: mock(async () => productGroup()),
    hasActiveEntitlement: mock(
      async (_buyerId, _group, catalogProductId) => catalogProductId === 'catalog-jammr-jinxxy'
    ),
    resolvePublication: mock(async () => ({
      activeContentDigest: '66'.repeat(32),
      activePolicyVersion: 'active-content-policy-v1',
      aliasId: 'jammr',
      bindingRoot: '22'.repeat(32),
      catalogProductIds: ['catalog-jammr-gumroad', 'catalog-jammr-jinxxy'],
      commonRoot: '77'.repeat(32),
      creatorId: 'creator-1',
      logicalBytes: 42_000,
      logicalFiles: 12,
      manifestSha256: '33'.repeat(32),
      packageId: 'com.yucp.jammr',
      protectedFiles: [],
      protectedSourceRoot: '88'.repeat(32),
      protectionPolicyDigest: '99'.repeat(32),
      protectionPolicyId: 'common-only-v1',
      releaseRoot: '11'.repeat(32),
      version: '1.2.3',
      versionId: 'version-jammr-123',
    })),
    ...overrides,
  };
}

function request(body: Record<string, unknown>, token = 'valid-oauth-token'): Request {
  return new Request(`${issuer}/api/v2/package-installs/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function requestBody(): Record<string, unknown> {
  return {
    aliasId: 'jammr',
    catalogProductIds: ['catalog-jammr-gumroad', 'catalog-jammr-jinxxy'],
    deviceKeyThumbprint,
    idempotencyKey: 'lifecycle-run-1',
    operation: 'install',
  };
}

function materializationProof(input: {
  deliveryGrant: string;
  privateKey?: KeyObject;
  publicKey?: KeyObject;
  target: string;
}): { proof: string; thumbprint: string } {
  const generated = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const proofPrivateKey = input.privateKey ?? generated.privateKey;
  const proofPublicKey = input.publicKey ?? generated.publicKey;
  const jwk = proofPublicKey.export({ format: 'jwk' });
  const canonicalJwk = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const header = encode({ alg: 'ES256', jwk, typ: 'dpop+jwt' });
  const payload = encode({
    ath: createHash('sha256').update(input.deliveryGrant, 'ascii').digest('base64url'),
    htm: 'POST',
    htu: input.target,
    iat: Math.floor(Date.now() / 1_000),
    jti: 'status-proof-1',
  });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`, 'ascii'), {
    dsaEncoding: 'ieee-p1363',
    key: proofPrivateKey,
  }).toString('base64url');
  return {
    proof: `${header}.${payload}.${signature}`,
    thumbprint: createHash('sha256').update(canonicalJwk).digest('hex'),
  };
}

describe('package install session route', () => {
  test('accepts entitlement from any storefront in one deduplicated product group', async () => {
    const port = accessPort();
    const handler = createPackageInstallSessionRoute({
      accessPort: port,
      audience,
      issuer,
      keyId,
      privateKey,
      verifyAccessToken: mock(async () => ({ ok: true as const, buyerId: 'buyer-1' })),
    });

    const response = await handler(request(requestBody()));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = (await response.json()) as {
      deliveryGrant: string;
      deliveryGrantPurpose: string;
      installSession: string;
      installSessionPurpose: string;
      releaseRoot: string;
      versionId: string;
    };
    expect(Object.keys(body).sort()).toEqual([
      'deliveryGrant',
      'deliveryGrantPurpose',
      'installSession',
      'installSessionPurpose',
      'releaseRoot',
      'versionId',
    ]);
    expect(body).toMatchObject({
      releaseRoot: '11'.repeat(32),
      versionId: 'version-jammr-123',
    });
    expect(port.hasActiveEntitlement).toHaveBeenCalledTimes(2);

    const session = await verifyInstallSessionV2({
      coseSign1: Uint8Array.from(Buffer.from(body.installSession, 'base64url')),
      expectedKeyId: new TextEncoder().encode(keyId),
      publicKey,
      context: {
        aliasId: 'jammr',
        allowedApiOrigins: [issuer],
        allowedArtifactOrigins: [audience],
        audience,
        bindingRoot: Uint8Array.from(Buffer.from('22'.repeat(32), 'hex')),
        deviceKeyThumbprint: Uint8Array.from(Buffer.from(deviceKeyThumbprint, 'hex')),
        issuer,
        now: Math.floor(Date.now() / 1000),
        operation: 'install',
        releaseRoot: Uint8Array.from(Buffer.from('11'.repeat(32), 'hex')),
      },
    });
    await expect(
      verifyDeliveryGrantV2({
        coseSign1: Uint8Array.from(Buffer.from(body.deliveryGrant, 'base64url')),
        expectedKeyId: new TextEncoder().encode(keyId),
        publicKey,
        context: {
          audience,
          deviceKeyThumbprint: Uint8Array.from(Buffer.from(deviceKeyThumbprint, 'hex')),
          issuer,
          now: session.issuedAt,
          requiredScope: 'package:version-jammr-123:read',
        },
      })
    ).resolves.toMatchObject({ installSessionId: session.sessionId });
  });

  test('resolves an exact retained release root for repair or rollback', async () => {
    const resolvePublication = mock(async () => ({
      activeContentDigest: '66'.repeat(32),
      activePolicyVersion: 'active-content-policy-v1',
      aliasId: 'jammr',
      bindingRoot: '22'.repeat(32),
      catalogProductIds: ['catalog-jammr-gumroad', 'catalog-jammr-jinxxy'],
      commonRoot: '77'.repeat(32),
      creatorId: 'creator-1',
      logicalBytes: 42_000,
      logicalFiles: 12,
      manifestSha256: '33'.repeat(32),
      packageId: 'com.yucp.jammr',
      protectedFiles: [],
      protectedSourceRoot: '88'.repeat(32),
      protectionPolicyDigest: '99'.repeat(32),
      protectionPolicyId: 'common-only-v1',
      releaseRoot: '11'.repeat(32),
      version: '1.0.0',
      versionId: 'version-jammr-100',
    }));
    const port = accessPort({ resolvePublication });
    const handler = createPackageInstallSessionRoute({
      accessPort: port,
      audience,
      issuer,
      keyId,
      privateKey,
      verifyAccessToken: async () => ({ ok: true, buyerId: 'buyer-1' }),
    });

    const response = await handler(
      request({
        ...requestBody(),
        targetReleaseRoot: '11'.repeat(32),
      })
    );

    expect(response.status).toBe(200);
    expect(resolvePublication).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: 'com.yucp.jammr' }),
      '11'.repeat(32)
    );
    expect(await response.json()).toMatchObject({
      releaseRoot: '11'.repeat(32),
      versionId: 'version-jammr-100',
    });
  });

  test('returns 403 before publication lookup when no storefront entitlement is active', async () => {
    const port = accessPort({ hasActiveEntitlement: mock(async () => false) });
    const handler = createPackageInstallSessionRoute({
      accessPort: port,
      audience,
      issuer,
      keyId,
      privateKey,
      verifyAccessToken: async () => ({ ok: true, buyerId: 'buyer-1' }),
    });

    const response = await handler(request(requestBody()));
    expect(response.status).toBe(403);
    expect(port.resolvePublication).not.toHaveBeenCalled();
  });

  test('rejects a partial or substituted storefront group', async () => {
    const port = accessPort();
    const handler = createPackageInstallSessionRoute({
      accessPort: port,
      audience,
      issuer,
      keyId,
      privateKey,
      verifyAccessToken: async () => ({ ok: true, buyerId: 'buyer-1' }),
    });

    const response = await handler(
      request({
        ...requestBody(),
        catalogProductIds: ['catalog-jammr-jinxxy'],
      })
    );
    expect(response.status).toBe(404);
    expect(port.hasActiveEntitlement).not.toHaveBeenCalled();
  });

  test('rejects missing OAuth authorization', async () => {
    const handler = createPackageInstallSessionRoute({
      accessPort: accessPort(),
      audience,
      issuer,
      keyId,
      privateKey,
      verifyAccessToken: async () => ({ ok: false, status: 401 }),
    });
    const response = await handler(request(requestBody(), 'invalid'));
    expect(response.status).toBe(401);
  });

  test('creates one idempotent Linux materialization job for protected files', async () => {
    const createJob = mock(async (_input: unknown) => undefined);
    const port = accessPort({
      resolvePublication: mock(async () => ({
        activeContentDigest: '66'.repeat(32),
        activePolicyVersion: 'active-content-policy-v1',
        aliasId: 'jammr',
        bindingRoot: '22'.repeat(32),
        catalogProductIds: ['catalog-jammr-gumroad', 'catalog-jammr-jinxxy'],
        commonRoot: '77'.repeat(32),
        creatorId: 'creator-1',
        logicalBytes: 42_000,
        logicalFiles: 12,
        manifestSha256: '33'.repeat(32),
        packageId: 'com.yucp.jammr',
        protectedFiles: [
          {
            materializerType: 'png',
            normalizedPath: 'Assets/Jammr/a.png',
            required: true,
            sourceSha256: 'aa'.repeat(32),
          },
        ],
        protectedSourceRoot: '88'.repeat(32),
        protectionPolicyDigest: '99'.repeat(32),
        protectionPolicyId: 'supported-visual-assets-v1',
        releaseRoot: '11'.repeat(32),
        version: '1.2.3',
        versionId: 'version-jammr-123',
      })),
    });
    const handler = createPackageInstallSessionRoute({
      accessPort: port,
      audience,
      issuer,
      keyId,
      materializationControl: { createJob },
      privateKey,
      verifyAccessToken: async () => ({ ok: true, buyerId: 'buyer-1' }),
    });

    const first = await handler(request(requestBody()));
    const second = await handler(request(requestBody()));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as {
      deliveryGrant: string;
      materializationJobId: string;
    };
    const secondBody = (await second.json()) as {
      deliveryGrant: string;
      materializationJobId: string;
    };
    expect(firstBody.materializationJobId).toBe(secondBody.materializationJobId);
    expect(createJob).toHaveBeenCalledTimes(2);
    expect(createJob.mock.calls[0]?.[0]).toMatchObject({
      buyerId: 'buyer-1',
      creatorId: 'creator-1',
      jobId: firstBody.materializationJobId,
      productId: 'com.yucp.jammr',
      sourceVersionId: 'version-jammr-123',
    });
    expect(createJob.mock.calls[0]?.[0]).not.toHaveProperty('protectedFiles');
    const signedGrant = await verifyDeliveryGrantV2({
      coseSign1: Buffer.from(firstBody.deliveryGrant, 'base64url'),
      expectedKeyId: new TextEncoder().encode(keyId),
      publicKey,
      context: {
        audience,
        deviceKeyThumbprint: Buffer.from(deviceKeyThumbprint, 'hex'),
        issuer,
        now: Math.floor(Date.now() / 1000),
        requiredScope: `materialization:${firstBody.materializationJobId}:read`,
      },
    });
    expect(createJob.mock.calls[0]?.[0]).toMatchObject({
      grantJti: signedGrant.grantId,
    });
  });

  test('issues metadata-only preflight without creating a protected materialization job', async () => {
    const createJob = mock(async (_input: unknown) => undefined);
    const port = accessPort({
      resolvePublication: mock(async () => ({
        activeContentDigest: '66'.repeat(32),
        activePolicyVersion: 'active-content-policy-v1',
        aliasId: 'jammr',
        bindingRoot: '22'.repeat(32),
        catalogProductIds: ['catalog-jammr-gumroad', 'catalog-jammr-jinxxy'],
        commonRoot: '77'.repeat(32),
        creatorId: 'creator-1',
        logicalBytes: 42_000,
        logicalFiles: 12,
        manifestSha256: '33'.repeat(32),
        packageId: 'com.yucp.jammr',
        protectedFiles: [
          {
            materializerType: 'png',
            normalizedPath: 'Assets/Jammr/a.png',
            required: true,
            sourceSha256: 'aa'.repeat(32),
          },
        ],
        protectedSourceRoot: '88'.repeat(32),
        protectionPolicyDigest: '99'.repeat(32),
        protectionPolicyId: 'supported-visual-assets-v1',
        releaseRoot: '11'.repeat(32),
        version: '1.2.3',
        versionId: 'version-jammr-123',
      })),
    });
    const handler = createPackageInstallSessionRoute({
      accessPort: port,
      audience,
      issuer,
      keyId,
      materializationControl: { createJob },
      privateKey,
      verifyAccessToken: async () => ({ ok: true, buyerId: 'buyer-1' }),
    });

    const response = await handler(
      request({
        ...requestBody(),
        operation: 'preflight',
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      installSession: string;
      materializationJobId?: string;
    };
    expect(body).not.toHaveProperty('materializationJobId');
    expect(createJob).not.toHaveBeenCalled();
    const session = await verifyInstallSessionV2({
      coseSign1: Buffer.from(body.installSession, 'base64url'),
      expectedKeyId: new TextEncoder().encode(keyId),
      publicKey,
      context: {
        aliasId: 'jammr',
        allowedApiOrigins: [issuer],
        allowedArtifactOrigins: [audience],
        audience,
        bindingRoot: Buffer.from('22'.repeat(32), 'hex'),
        deviceKeyThumbprint: Buffer.from(deviceKeyThumbprint, 'hex'),
        issuer,
        now: Math.floor(Date.now() / 1_000),
        operation: 'preflight',
        releaseRoot: Buffer.from('11'.repeat(32), 'hex'),
      },
    });
    expect(session).toMatchObject({ operation: 'preflight' });
  });

  test('authorizes materialization status with the signed grant and device DPoP key', async () => {
    const endpoint = `${issuer}/api/v2/package-installs/materialization-status`;
    const pending = {
      queuePosition: 1,
      state: 'QUEUED' as const,
      status: 'pending' as const,
    };
    const getStatus = mock(async (_input: unknown) => pending);
    const proofKeyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const proofInput = materializationProof({
      deliveryGrant: 'temporary',
      privateKey: proofKeyPair.privateKey,
      publicKey: proofKeyPair.publicKey,
      target: endpoint,
    });
    const issued = await issuePackageInstallSession({
      audience,
      buyerId: 'buyer-1',
      deliveryGrantId: 'grant-protected-1',
      deviceKeyThumbprint: proofInput.thumbprint,
      issuer,
      keyId,
      materializationJobId: 'job-protected-1',
      now: Math.floor(Date.now() / 1_000),
      operation: 'install',
      privateKey,
      publication: {
        activeContentDigest: '66'.repeat(32),
        activePolicyVersion: 'active-content-policy-v1',
        aliasId: 'jammr',
        bindingRoot: '22'.repeat(32),
        catalogProductIds: ['catalog-jammr-jinxxy'],
        commonRoot: '77'.repeat(32),
        creatorId: 'creator-1',
        logicalBytes: 100,
        logicalFiles: 1,
        manifestSha256: '33'.repeat(32),
        packageId: 'com.yucp.jammr',
        protectedFiles: [
          {
            materializerType: 'png',
            normalizedPath: 'Assets/Jammr/a.png',
            required: true,
            sourceSha256: 'aa'.repeat(32),
          },
        ],
        protectedSourceRoot: '88'.repeat(32),
        protectionPolicyDigest: '99'.repeat(32),
        protectionPolicyId: 'supported-visual-assets-v1',
        releaseRoot: '11'.repeat(32),
        version: '1.2.3',
        versionId: 'version-jammr-123',
      },
      sessionId: 'session-protected-1',
    });
    const deliveryGrant = Buffer.from(issued.deliveryGrant).toString('base64url');
    const { proof } = materializationProof({
      deliveryGrant,
      privateKey: proofKeyPair.privateKey,
      publicKey: proofKeyPair.publicKey,
      target: endpoint,
    });
    const handler = createPackageMaterializationStatusRoute({
      audience,
      issuer,
      keyId,
      materializationControl: {
        getStatus,
      },
      privateKey,
    });
    const response = await handler(
      new Request(endpoint, {
        body: JSON.stringify({
          deliveryGrant,
          jobId: 'job-protected-1',
          proof,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(pending);
    expect(getStatus.mock.calls[0]?.[0]).toEqual({
      grantJti: 'grant-protected-1',
      jobId: 'job-protected-1',
    });
  });
});
