import { describe, expect, mock, test } from 'bun:test';
import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import * as ed25519 from '@noble/ed25519';
import {
  encodePackageOperationCapabilityV2,
  PACKAGE_CONTRACT_PURPOSES,
  packageContractKeyId,
  signPackageContract,
  verifyDeliveryGrantV2,
  verifyInstallSessionV2,
  verifyPackageOperationCapabilityV2,
} from '../../../../ops/storage-core/packageContractsV2';
import { ACTIVE_PROTECTION_POLICY_ID } from '../../../../ops/storage-core/protectionPolicyId';
import { signYucpBootstrapIntent } from '../lib/bootstrapIntentSigner';
import { issuePackageInstallSession } from '../lib/packageInstallSessionIssuer';
import {
  createPackageInstallSessionRenewalRoute,
  createPackageInstallSessionRoute,
  createPackageMaterializationStatusRoute,
  createPackageOperationAuthorizationRoute,
  type PackageInstallAccessPort,
  type PackageInstallProductGroup,
  type PackageInstallReleasePinControl,
  type PackageOperationAuthorizationPort,
} from './packageInstallSessions';

const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const publicKey = await ed25519.getPublicKeyAsync(privateKey);
const issuer = 'https://api.example.test';
const verificationBaseUrl = 'https://app.example.test';
const audience = 'https://delivery.example.test';
const keyId = 'install-session-test-1';
const deviceKeyThumbprint = '44'.repeat(32);
const defaultReleasePins = {
  acquireReleasePin: async () => ({ pinId: 'pin-default' }),
  releaseReleasePin: async () => undefined,
};
const projectIdentity = '55'.repeat(32);
const emptyReleaseRoot = '00'.repeat(32);
const traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
const defaultAuthorizationPort: PackageOperationAuthorizationPort = {
  beginExchange: async () => ({ generation: 1, status: 'claimed' }),
  beginRenewal: async () => ({
    capabilityId: `operation-${'77'.repeat(24)}`,
    generation: 1,
    grantId: 'grant-default',
    issuedAt: new Date(),
    renewableUntil: new Date(Date.now() + 60 * 60 * 1_000),
    status: 'claimed',
  }),
  completeExchange: async () => true,
  completeRenewal: async () => true,
  releaseRenewal: async () => true,
  releaseExchange: async () => true,
  reserve: async (record) => ({ record, status: 'created' }),
};

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
  const publication = async () => ({
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
    protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
    releaseRoot: '11'.repeat(32),
    version: '1.2.3',
    versionId: 'version-jammr-123',
  });
  return {
    resolveProductGroup: mock(async () => productGroup()),
    resolveEntitledEdition: mock(async () => 'commercial'),
    resolveInstalledRelease: mock(publication),
    resolvePublication: mock(publication),
    ...overrides,
  };
}

function request(
  body: Record<string, unknown>,
  token = 'valid-oauth-token',
  scheme: 'Bearer' | 'DPoP' = 'DPoP'
): Request {
  return new Request(`${issuer}/api/v2/package-installs/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `${scheme} ${token}`,
      'Content-Type': 'application/json',
      DPoP: 'signed-proof',
    },
    body: JSON.stringify(body),
  });
}

async function requestBody(
  overrides: Record<string, unknown> = {},
  capabilityOverrides: {
    expiresAt?: number;
    issuedAt?: number;
    notBefore?: number;
  } = {}
): Promise<Record<string, unknown>> {
  const operation = typeof overrides.operation === 'string' ? overrides.operation : 'install';
  const now = Math.floor(Date.now() / 1_000);
  const base = {
    aliasId: 'jammr',
    ...(operation === 'preflight'
      ? {}
      : {
          approvedActiveContentDigest: '66'.repeat(32),
          approvedPolicyVersion: 'active-content-policy-v1',
        }),
    expectedCurrentReleaseRoot: emptyReleaseRoot,
    idempotencyKey: 'lifecycle-run-1',
    operation,
    projectIdentity,
    targetReleaseRoot: '11'.repeat(32),
    traceparent,
    ...overrides,
  };
  const signed = await signPackageContract({
    keyId: packageContractKeyId(keyId),
    payload: encodePackageOperationCapabilityV2({
      aliasId: base.aliasId as string,
      ...(base.approvedActiveContentDigest
        ? {
            approvedActiveContentDigest: Uint8Array.from(
              Buffer.from(base.approvedActiveContentDigest as string, 'hex')
            ),
          }
        : {}),
      ...(base.approvedPolicyVersion
        ? { approvedPolicyVersion: base.approvedPolicyVersion as string }
        : {}),
      audience: issuer,
      buyerId: 'buyer-1',
      capabilityId: `operation-${'77'.repeat(24)}`,
      deviceKeyThumbprint: Uint8Array.from(Buffer.from(deviceKeyThumbprint, 'hex')),
      expectedCurrentReleaseRoot: Uint8Array.from(
        Buffer.from(base.expectedCurrentReleaseRoot as string, 'hex')
      ),
      expiresAt: capabilityOverrides.expiresAt ?? now + 240,
      idempotencyKey: base.idempotencyKey as string,
      issuedAt: capabilityOverrides.issuedAt ?? now,
      issuer,
      notBefore: capabilityOverrides.notBefore ?? now,
      oneUseNonce: new Uint8Array(32).fill(0x88),
      operation: operation as
        | 'install'
        | 'preflight'
        | 'recover'
        | 'repair'
        | 'rollback'
        | 'uninstall'
        | 'update',
      projectIdentity: Uint8Array.from(Buffer.from(projectIdentity, 'hex')),
      releaseRoot: Uint8Array.from(Buffer.from(base.targetReleaseRoot as string, 'hex')),
      traceparent,
    }),
    privateKey,
    purpose: PACKAGE_CONTRACT_PURPOSES.packageOperationCapability,
  });
  return {
    ...base,
    operationCapability: Buffer.from(signed.coseSign1).toString('base64url'),
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
  test('binds an explicit update authorization to its signed Specific intent', async () => {
    const intent = await signYucpBootstrapIntent({
      aliasId: 'jammr',
      config: { keyId, privateKey },
      intent: {
        schemaVersion: 1,
        intentId: '11111111-1111-4111-8111-111111111111',
        mode: 'specific',
        issuedAt: Math.floor(Date.now() / 1_000),
        editionId: 'commercial',
        version: '1.2.3',
        versionId: 'version-jammr-123',
        releaseRoot: '11'.repeat(32),
      },
    });
    const port = accessPort();
    const handler = createPackageOperationAuthorizationRoute({
      accessPort: port,
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      keyId,
      privateKey,
      verificationBaseUrl,
      verifyAccessRequest: async () => ({
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
        ok: true,
      }),
    });
    const {
      operationCapability: _unused,
      targetReleaseRoot: _target,
      ...operation
    } = await requestBody({
      bootstrapIntentJson: JSON.stringify(intent),
      expectedCurrentReleaseRoot: 'aa'.repeat(32),
      operation: 'preflight',
    });

    const response = await handler(request(operation));

    expect(response.status).toBe(201);
    expect(port.resolvePublication).toHaveBeenCalledWith(
      productGroup(),
      'commercial',
      '11'.repeat(32)
    );
  });

  test('issues only a signed one-time operation capability to the native broker', async () => {
    const reserve = mock(
      async (record: Parameters<PackageOperationAuthorizationPort['reserve']>[0]) => ({
        record,
        status: 'created' as const,
      })
    );
    const handler = createPackageOperationAuthorizationRoute({
      accessPort: accessPort(),
      authorizationPort: {
        ...defaultAuthorizationPort,
        reserve,
      },
      audience,
      issuer,
      keyId,
      privateKey,
      verificationBaseUrl,
      verifyAccessRequest: async () => ({
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
        ok: true,
      }),
    });
    const { operationCapability: _unused, ...operation } = await requestBody();

    const response = await handler(request(operation));

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'operationCapability', 'releaseRoot']);
    expect(body).not.toHaveProperty('deliveryGrant');
    expect(body).not.toHaveProperty('installSession');
    expect(reserve).toHaveBeenCalledTimes(1);
    await expect(
      verifyPackageOperationCapabilityV2({
        context: {
          aliasId: 'jammr',
          approvedActiveContentDigest: Buffer.from('66'.repeat(32), 'hex'),
          approvedPolicyVersion: 'active-content-policy-v1',
          audience: issuer,
          deviceKeyThumbprint: Buffer.from(deviceKeyThumbprint, 'hex'),
          expectedCurrentReleaseRoot: Buffer.from(emptyReleaseRoot, 'hex'),
          idempotencyKey: 'lifecycle-run-1',
          issuer,
          now: Math.floor(Date.now() / 1_000),
          operation: 'install',
          projectIdentity: Buffer.from(projectIdentity, 'hex'),
          releaseRoot: Buffer.from('11'.repeat(32), 'hex'),
        },
        coseSign1: Buffer.from(body.operationCapability as string, 'base64url'),
        expectedKeyId: packageContractKeyId(keyId),
        publicKey,
      })
    ).resolves.toMatchObject({
      buyerId: 'buyer-1',
      operation: 'install',
    });
  });

  test('authorizes uninstall from retained installed-release identity', async () => {
    const retainedPublication = await accessPort().resolvePublication(productGroup(), 'commercial');
    if (!retainedPublication) {
      throw new Error('test publication is unavailable');
    }
    const resolvePublication = mock(async () => null);
    const resolveInstalledRelease = mock(async () => retainedPublication);
    const port = accessPort({ resolvePublication });
    Object.assign(port, { resolveInstalledRelease });
    const handler = createPackageOperationAuthorizationRoute({
      accessPort: port,
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      keyId,
      privateKey,
      verificationBaseUrl,
      verifyAccessRequest: async () => ({
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
        ok: true,
      }),
    });
    const { operationCapability: _unused, ...operation } = await requestBody({
      expectedCurrentReleaseRoot: retainedPublication.releaseRoot,
      operation: 'uninstall',
      targetReleaseRoot: retainedPublication.releaseRoot,
    });

    const response = await handler(request(operation));

    expect(response.status).toBe(201);
    expect(resolveInstalledRelease).toHaveBeenCalledWith(
      productGroup(),
      'commercial',
      retainedPublication.releaseRoot
    );
    expect(resolvePublication).not.toHaveBeenCalled();
  });

  test('issues uninstall authorization without package read or release retention', async () => {
    const retainedPublication = await accessPort().resolvePublication(productGroup(), 'commercial');
    if (!retainedPublication) {
      throw new Error('test publication is unavailable');
    }
    const resolvePublication = mock(async () => null);
    const resolveInstalledRelease = mock(async () => retainedPublication);
    const port = accessPort({ resolvePublication });
    Object.assign(port, { resolveInstalledRelease });
    const acquireReleasePin = mock(async () => ({ pinId: 'must-not-pin' }));
    const handler = createPackageInstallSessionRoute({
      accessPort: port,
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      keyId,
      privateKey,
      releasePins: {
        acquireReleasePin,
        releaseReleasePin: async () => undefined,
      },
      verificationBaseUrl,
      verifyAccessRequest: async () => ({
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
        ok: true,
      }),
    });

    const response = await handler(
      request(
        await requestBody({
          expectedCurrentReleaseRoot: retainedPublication.releaseRoot,
          operation: 'uninstall',
          targetReleaseRoot: retainedPublication.releaseRoot,
        })
      )
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, string>;
    const grant = await verifyDeliveryGrantV2({
      context: {
        audience,
        deviceKeyThumbprint: Buffer.from(deviceKeyThumbprint, 'hex'),
        issuer,
        now: Math.floor(Date.now() / 1_000),
        requiredScope: `package:${retainedPublication.versionId}:uninstall`,
      },
      coseSign1: Buffer.from(body.deliveryGrant, 'base64url'),
      expectedKeyId: packageContractKeyId(keyId),
      publicKey,
    });
    expect(grant.scopes).not.toContain(`package:${retainedPublication.versionId}:read`);
    expect(acquireReleasePin).not.toHaveBeenCalled();
    expect(resolvePublication).not.toHaveBeenCalled();
  });

  test('rejects uninstall when the installed and target release roots differ', async () => {
    const port = accessPort();
    const handler = createPackageOperationAuthorizationRoute({
      accessPort: port,
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      keyId,
      privateKey,
      verificationBaseUrl,
      verifyAccessRequest: async () => ({
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
        ok: true,
      }),
    });
    const { operationCapability: _unused, ...operation } = await requestBody({
      expectedCurrentReleaseRoot: '12'.repeat(32),
      operation: 'uninstall',
      targetReleaseRoot: '11'.repeat(32),
    });

    const response = await handler(request(operation));

    expect(response.status).toBe(400);
    expect(port.resolveProductGroup).not.toHaveBeenCalled();
  });

  test('returns the persisted capability when a completed exchange response was lost', async () => {
    let persistedRecord:
      | Awaited<ReturnType<PackageOperationAuthorizationPort['reserve']>>['record']
      | undefined;
    const reserve = mock(
      async (record: Parameters<PackageOperationAuthorizationPort['reserve']>[0]) => {
        if (!persistedRecord) {
          persistedRecord = record;
          return { record, status: 'created' as const };
        }
        return { record: persistedRecord, status: 'consumed' as const };
      }
    );
    const handler = createPackageOperationAuthorizationRoute({
      accessPort: accessPort(),
      authorizationPort: {
        ...defaultAuthorizationPort,
        reserve,
      },
      audience,
      issuer,
      keyId,
      privateKey,
      verificationBaseUrl,
      verifyAccessRequest: async () => ({
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
        ok: true,
      }),
    });
    const { operationCapability: _unused, ...operation } = await requestBody();

    const firstResponse = await handler(request(operation));
    const firstBody = (await firstResponse.json()) as Record<string, unknown>;
    const retryResponse = await handler(request(operation));
    const retryBody = (await retryResponse.json()) as Record<string, unknown>;

    expect(firstResponse.status).toBe(201);
    expect(retryResponse.status).toBe(200);
    expect(retryBody).toEqual(firstBody);
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  test('renews an expired grant for the same DPoP device and entitled release', async () => {
    const renewalTraceparent = '00-0123456789abcdef0123456789abcdef-fedcba9876543210-01';
    const initialIssuedAt = Math.floor(Date.now() / 1_000) - 301;
    const initial = await issuePackageInstallSession({
      audience,
      buyerId: 'buyer-1',
      deliveryGrantId: 'grant-initial',
      deviceKeyThumbprint,
      issuer,
      keyId,
      now: initialIssuedAt,
      operation: 'install',
      privateKey,
      publication: await accessPort()
        .resolvePublication(productGroup(), 'commercial')
        .then((publication) => {
          if (!publication) {
            throw new Error('test publication is unavailable');
          }
          return publication;
        }),
      sessionId: 'session-renewable',
    });
    const renewalClaimIssuedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000 + 731);
    const beginRenewal = mock(async () => ({
      capabilityId: `operation-${'77'.repeat(24)}`,
      generation: 1,
      grantId: 'grant-initial',
      issuedAt: renewalClaimIssuedAt,
      renewableUntil: new Date(Date.now() + 60 * 60 * 1_000),
      status: 'claimed' as const,
    }));
    const completeRenewal = mock(async () => true);
    const port = accessPort();
    const handler = createPackageInstallSessionRenewalRoute({
      accessPort: port,
      authorizationPort: {
        ...defaultAuthorizationPort,
        beginRenewal,
        completeRenewal,
      },
      audience,
      issuer,
      keyId,
      privateKey,
      releasePins: defaultReleasePins,
      verificationBaseUrl,
      verifyAccessRequest: async () => ({
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
        ok: true,
      }),
    });
    const response = await handler(
      new Request(`${issuer}/api/v2/package-installs/renewals`, {
        body: JSON.stringify({
          deliveryGrant: Buffer.from(initial.deliveryGrant).toString('base64url'),
          installSession: Buffer.from(initial.installSession).toString('base64url'),
          traceparent: renewalTraceparent,
        }),
        headers: {
          Authorization: 'DPoP valid-oauth-token',
          'Content-Type': 'application/json',
          DPoP: 'signed-proof',
        },
        method: 'POST',
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, string>;
    expect(beginRenewal).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
        sessionId: 'session-renewable',
      })
    );
    // The renewal is located by session, not by the trace the caller happens to be on.
    expect(beginRenewal).not.toHaveBeenCalledWith(
      expect.objectContaining({ traceId: expect.anything() })
    );
    expect(completeRenewal).toHaveBeenCalledTimes(1);
    expect(completeRenewal).toHaveBeenCalledWith(
      expect.objectContaining({
        issuedAt: new Date(Math.floor(renewalClaimIssuedAt.getTime() / 1_000) * 1_000),
      })
    );
    await expect(
      verifyDeliveryGrantV2({
        context: {
          audience,
          deviceKeyThumbprint: Buffer.from(deviceKeyThumbprint, 'hex'),
          issuer,
          now: Math.floor(Date.now() / 1_000),
          requiredScope: 'package:version-jammr-123:read',
        },
        coseSign1: Buffer.from(body.deliveryGrant, 'base64url'),
        expectedKeyId: packageContractKeyId(keyId),
        publicKey,
      })
    ).resolves.toMatchObject({
      buyerId: 'buyer-1',
      grantId: 'grant-initial',
      installSessionId: 'session-renewable',
    });
  });

  test('renews deleted-release uninstall identity without package read scope', async () => {
    const publication = await accessPort().resolvePublication(productGroup(), 'commercial');
    if (!publication) {
      throw new Error('test publication is unavailable');
    }
    const initial = await issuePackageInstallSession({
      audience,
      buyerId: 'buyer-1',
      deliveryGrantId: 'grant-uninstall',
      deviceKeyThumbprint,
      issuer,
      keyId,
      now: Math.floor(Date.now() / 1_000) - 301,
      operation: 'uninstall',
      privateKey,
      publication,
      sessionId: 'session-uninstall',
    });
    const resolvePublication = mock(async () => null);
    const resolveInstalledRelease = mock(async () => publication);
    const handler = createPackageInstallSessionRenewalRoute({
      accessPort: accessPort({ resolveInstalledRelease, resolvePublication }),
      authorizationPort: {
        ...defaultAuthorizationPort,
        beginRenewal: async () => ({
          capabilityId: `operation-${'77'.repeat(24)}`,
          generation: 1,
          grantId: 'grant-uninstall',
          issuedAt: new Date(),
          renewableUntil: new Date(Date.now() + 60 * 60 * 1_000),
          status: 'claimed',
        }),
      },
      audience,
      issuer,
      keyId,
      privateKey,
      verificationBaseUrl,
      verifyAccessRequest: async () => ({
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
        ok: true,
      }),
    });

    const response = await handler(
      new Request(`${issuer}/api/v2/package-installs/renewals`, {
        body: JSON.stringify({
          deliveryGrant: Buffer.from(initial.deliveryGrant).toString('base64url'),
          installSession: Buffer.from(initial.installSession).toString('base64url'),
          traceparent,
        }),
        headers: {
          Authorization: 'DPoP valid-oauth-token',
          'Content-Type': 'application/json',
          DPoP: 'signed-proof',
        },
        method: 'POST',
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, string>;
    const grant = await verifyDeliveryGrantV2({
      context: {
        audience,
        deviceKeyThumbprint: Buffer.from(deviceKeyThumbprint, 'hex'),
        issuer,
        now: Math.floor(Date.now() / 1_000),
        requiredScope: `package:${publication.versionId}:uninstall`,
      },
      coseSign1: Buffer.from(body.deliveryGrant, 'base64url'),
      expectedKeyId: packageContractKeyId(keyId),
      publicKey,
    });
    expect(grant.scopes).not.toContain(`package:${publication.versionId}:read`);
    expect(resolveInstalledRelease).toHaveBeenCalled();
    expect(resolvePublication).not.toHaveBeenCalled();
  });

  test('rejects a valid DPoP token when the broker proof header is missing', async () => {
    const port = accessPort();
    const verifyAccessRequest = mock(async () => ({
      buyerId: 'buyer-1',
      deviceKeyThumbprint,
      ok: true as const,
    }));
    const handler = createPackageOperationAuthorizationRoute({
      accessPort: port,
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      keyId,
      privateKey,
      verificationBaseUrl,
      verifyAccessRequest,
    });
    const { operationCapability: _unused, ...operation } = await requestBody();
    const response = await handler(
      new Request(`${issuer}/api/v2/package-installs/authorizations`, {
        method: 'POST',
        headers: {
          Authorization: 'DPoP valid-dpop-bound-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(operation),
      })
    );

    expect(response.status).toBe(401);
    expect(verifyAccessRequest).not.toHaveBeenCalled();
    expect(port.resolveProductGroup).not.toHaveBeenCalled();
  });

  test('reports DPoP verifier dependency outages as unavailable, not authentication failures', async () => {
    const port = accessPort();
    const handler = createPackageOperationAuthorizationRoute({
      accessPort: port,
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      keyId,
      privateKey,
      verificationBaseUrl,
      verifyAccessRequest: async () => ({ ok: false, status: 503 }),
    });
    const { operationCapability: _unused, ...operation } = await requestBody();

    const response = await handler(
      new Request(`${issuer}/api/v2/package-installs/authorizations`, {
        method: 'POST',
        headers: {
          Authorization: 'DPoP valid-dpop-bound-token',
          'Content-Type': 'application/json',
          DPoP: 'signed-proof',
        },
        body: JSON.stringify(operation),
      })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Package authorization service unavailable',
      errorCode: 'AUTH_DEPENDENCY_UNAVAILABLE',
    });
    expect(port.resolveProductGroup).not.toHaveBeenCalled();
  });

  test('returns the RFC 9449 resource nonce challenge without treating it as expired authentication', async () => {
    const port = accessPort();
    const handler = createPackageOperationAuthorizationRoute({
      accessPort: port,
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      keyId,
      privateKey,
      verificationBaseUrl,
      verifyAccessRequest: async () => ({
        dpopNonce: 'server-time-nonce',
        ok: false,
        status: 401,
      }),
    });
    const { operationCapability: _unused, ...operation } = await requestBody();

    const response = await handler(
      new Request(`${issuer}/api/v2/package-installs/authorizations`, {
        method: 'POST',
        headers: {
          Authorization: 'DPoP valid-dpop-bound-token',
          'Content-Type': 'application/json',
          DPoP: 'signed-proof',
        },
        body: JSON.stringify(operation),
      })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('dpop-nonce')).toBe('server-time-nonce');
    expect(response.headers.get('www-authenticate')).toBe(
      'DPoP error="use_dpop_nonce", error_description="Resource server requires nonce in DPoP proof"'
    );
    expect(await response.json()).toEqual({
      error: 'use_dpop_nonce',
      error_description: 'Resource server requires nonce in DPoP proof',
    });
    expect(port.resolveProductGroup).not.toHaveBeenCalled();
  });

  test('rejects changed device, root, project, operation, or approval before consume', async () => {
    const original = await requestBody();
    const attempts = [
      {
        body: original,
        device: '45'.repeat(32),
        name: 'device',
      },
      {
        body: { ...original, targetReleaseRoot: '12'.repeat(32) },
        device: deviceKeyThumbprint,
        name: 'root',
      },
      {
        body: { ...original, projectIdentity: '56'.repeat(32) },
        device: deviceKeyThumbprint,
        name: 'project',
      },
      {
        body: { ...original, expectedCurrentReleaseRoot: '01'.repeat(32) },
        device: deviceKeyThumbprint,
        name: 'current root',
      },
      {
        body: { ...original, operation: 'update' },
        device: deviceKeyThumbprint,
        name: 'operation',
      },
      {
        body: { ...original, approvedActiveContentDigest: '67'.repeat(32) },
        device: deviceKeyThumbprint,
        name: 'approval',
        status: 409,
      },
    ] as const;

    for (const attempt of attempts) {
      const beginExchange = mock(async () => ({
        generation: 1,
        status: 'claimed' as const,
      }));
      const handler = createPackageInstallSessionRoute({
        accessPort: accessPort(),
        authorizationPort: {
          ...defaultAuthorizationPort,
          beginExchange,
        },
        audience,
        issuer,
        keyId,
        privateKey,
        releasePins: defaultReleasePins,
        verificationBaseUrl,
        verifyAccessRequest: async () => ({
          buyerId: 'buyer-1',
          deviceKeyThumbprint: attempt.device,
          ok: true,
        }),
      });

      const response = await handler(request(attempt.body));

      expect(response.status, attempt.name).toBe('status' in attempt ? attempt.status : 403);
      await expect(response.json()).resolves.toMatchObject({
        errorCode:
          attempt.name === 'approval'
            ? 'STALE_CONTENT_APPROVAL'
            : 'OPERATION_AUTHORIZATION_INVALID',
      });
      expect(beginExchange, attempt.name).not.toHaveBeenCalled();
    }
  });

  test('requires the current project release root before authorization work', async () => {
    const port = accessPort();
    const handler = createPackageOperationAuthorizationRoute({
      accessPort: port,
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      keyId,
      privateKey,
      verificationBaseUrl,
      verifyAccessRequest: async () => ({
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
        ok: true,
      }),
    });
    const {
      expectedCurrentReleaseRoot: _unusedCurrentRoot,
      operationCapability: _unusedCapability,
      ...operation
    } = await requestBody();

    const response = await handler(request(operation));

    expect(response.status).toBe(400);
    expect(port.resolveProductGroup).not.toHaveBeenCalled();
  });

  test('rejects an expired signed operation capability before consume', async () => {
    const now = Math.floor(Date.now() / 1_000);
    const beginExchange = mock(async () => ({
      generation: 1,
      status: 'claimed' as const,
    }));
    const handler = createPackageInstallSessionRoute({
      accessPort: accessPort(),
      authorizationPort: {
        ...defaultAuthorizationPort,
        beginExchange,
      },
      audience,
      issuer,
      keyId,
      privateKey,
      releasePins: defaultReleasePins,
      verificationBaseUrl,
      verifyAccessRequest: async () => ({
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
        ok: true,
      }),
    });

    const response = await handler(
      request(
        await requestBody(
          {},
          {
            expiresAt: now - 1,
            issuedAt: now - 240,
            notBefore: now - 240,
          }
        )
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: 'OPERATION_AUTHORIZATION_INVALID',
    });
    expect(beginExchange).not.toHaveBeenCalled();
  });

  test('accepts an authorization minted in an earlier trace', async () => {
    // A retry of a still-running operation reuses the idempotency key, so /authorizations replays
    // the reservation minted by the first attempt. The retry then presents that capability under
    // its own traceparent. Binding the trace made this the indistinguishable-from-forged 403 that
    // wedged every retry until the reservation expired.
    const beginExchange = mock(async () => ({
      generation: 1,
      status: 'claimed' as const,
    }));
    const handler = createPackageInstallSessionRoute({
      accessPort: accessPort(),
      authorizationPort: {
        ...defaultAuthorizationPort,
        beginExchange,
      },
      audience,
      issuer,
      keyId,
      privateKey,
      releasePins: defaultReleasePins,
      verificationBaseUrl,
      verifyAccessRequest: async () => ({
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
        ok: true,
      }),
    });
    const retryTraceparent = '00-a9c98fa4ff48aa4e7f1a198af2167e31-ef40582d9d0d9718-01';
    expect(retryTraceparent).not.toBe(traceparent);

    const response = await handler(request(await requestBody({ traceparent: retryTraceparent })));

    expect(response.status).toBe(200);
    expect(beginExchange).toHaveBeenCalledTimes(1);
  });

  test('reports a concurrent attempt as in progress rather than invalid', async () => {
    const beginExchange = mock(async () => ({ status: 'in_progress' as const }));
    const handler = createPackageInstallSessionRoute({
      accessPort: accessPort(),
      authorizationPort: {
        ...defaultAuthorizationPort,
        beginExchange,
      },
      audience,
      issuer,
      keyId,
      privateKey,
      releasePins: defaultReleasePins,
      verificationBaseUrl,
      verifyAccessRequest: async () => ({
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
        ok: true,
      }),
    });

    const response = await handler(
      request(
        await requestBody({
          traceparent: '00-a9c98fa4ff48aa4e7f1a198af2167e31-ef40582d9d0d9718-01',
        })
      )
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: 'OPERATION_AUTHORIZATION_IN_PROGRESS',
    });
  });

  test('separates a stale release target from a package with no release', async () => {
    async function preflight(overrides: Partial<PackageInstallAccessPort>) {
      const handler = createPackageOperationAuthorizationRoute({
        accessPort: accessPort(overrides),
        authorizationPort: defaultAuthorizationPort,
        audience,
        issuer,
        keyId,
        privateKey,
        verificationBaseUrl,
        verifyAccessRequest: async () => ({
          buyerId: 'buyer-1',
          deviceKeyThumbprint,
          ok: true,
        }),
      });
      const { operationCapability: _capability, ...operation } = await requestBody({
        operation: 'preflight',
        targetReleaseRoot: '99'.repeat(32),
      });
      const response = await handler(request(operation));
      return { body: (await response.json()) as Record<string, string>, status: response.status };
    }

    // The pinned target is gone but the package still has a current release.
    const current = await accessPort().resolvePublication(productGroup(), 'commercial');
    const stale = await preflight({
      resolvePublication: mock(async (_group, _edition, releaseRoot?: string) =>
        releaseRoot ? null : current
      ),
    });
    expect(stale.status).toBe(404);
    expect(stale.body.errorCode).toBe('RELEASE_ROOT_UNAVAILABLE');

    // Nothing is published for this edition at all.
    const unpublished = await preflight({
      resolvePublication: mock(async () => null),
    });
    expect(unpublished.status).toBe(404);
    expect(unpublished.body.errorCode).toBe('PRODUCT_NOT_PUBLISHED');
  });

  test('carries the diagnostics answer only to a client that asked for it', async () => {
    const consented = { diagnosticsEnabled: true, diagnosticsSessionId: 'diag-session-1' };
    async function issueWith(input: {
      consent: { diagnosticsEnabled: boolean; diagnosticsSessionId: string | null };
      sessionCapabilities?: string[];
    }) {
      const port = accessPort({
        resolveDiagnosticsConsent: mock(async () => input.consent),
      });
      const handler = createPackageInstallSessionRoute({
        accessPort: port,
        authorizationPort: defaultAuthorizationPort,
        audience,
        issuer,
        keyId,
        privateKey,
        releasePins: defaultReleasePins,
        verificationBaseUrl,
        verifyAccessRequest: async () => ({
          buyerId: 'buyer-1',
          deviceKeyThumbprint,
          ok: true,
        }),
      });
      const response = await handler(
        request(
          await requestBody(
            input.sessionCapabilities ? { sessionCapabilities: input.sessionCapabilities } : {}
          )
        )
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, string>;
      return await verifyInstallSessionV2({
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
    }

    const silent = await issueWith({ consent: consented });
    expect(silent.diagnostics).toBeUndefined();

    const asked = await issueWith({
      consent: consented,
      sessionCapabilities: ['install-session-diagnostics'],
    });
    expect(asked.diagnostics).toEqual({ enabled: true, sessionId: 'diag-session-1' });

    const declined = await issueWith({
      consent: { diagnosticsEnabled: false, diagnosticsSessionId: null },
      sessionCapabilities: ['install-session-diagnostics'],
    });
    expect(declined.diagnostics).toEqual({ enabled: false });
  });

  test('rejects a bearer-only native request before access or publication work', async () => {
    const port = accessPort();
    const verifyAccessRequest = mock(async () => ({
      ok: true as const,
      buyerId: 'buyer-1',
      deviceKeyThumbprint,
    }));
    const handler = createPackageInstallSessionRoute({
      accessPort: port,
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      verificationBaseUrl,
      keyId,
      privateKey,
      releasePins: defaultReleasePins,
      verifyAccessRequest,
    });

    const response = await handler(request(await requestBody(), 'valid-oauth-token', 'Bearer'));

    expect(response.status).toBe(401);
    expect(verifyAccessRequest).not.toHaveBeenCalled();
    expect(port.resolveProductGroup).not.toHaveBeenCalled();
    expect(port.resolveEntitledEdition).not.toHaveBeenCalled();
    expect(port.resolvePublication).not.toHaveBeenCalled();
  });

  test('accepts entitlement from any storefront in one deduplicated product group', async () => {
    const port = accessPort();
    const acquireReleasePin = mock(
      async (_input: Parameters<PackageInstallReleasePinControl['acquireReleasePin']>[0]) => ({
        pinId: 'pin-session-1',
      })
    );
    const releaseReleasePin = mock(async () => undefined);
    const startedAt = Date.now();
    const handler = createPackageInstallSessionRoute({
      accessPort: port,
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      verificationBaseUrl,
      keyId,
      privateKey,
      releasePins: { acquireReleasePin, releaseReleasePin },
      verifyAccessRequest: mock(async () => ({
        ok: true as const,
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
      })),
    });

    const response = await handler(request(await requestBody()));
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
    expect(port.resolveEntitledEdition).toHaveBeenCalledWith(
      'buyer-1',
      expect.objectContaining({ packageId: 'com.yucp.jammr' })
    );
    expect(acquireReleasePin).toHaveBeenCalledTimes(1);
    expect(acquireReleasePin.mock.calls[0]?.[0]).toMatchObject({
      ownerId: expect.stringMatching(/^session-/),
      packageVersionId: 'version-jammr-123',
      pinKind: 'delivery-binding',
    });
    const pinExpiry = Date.parse(
      (acquireReleasePin.mock.calls[0]?.[0] as { expiresAt: string }).expiresAt
    );
    expect(pinExpiry).toBeGreaterThanOrEqual(startedAt + 5 * 60 * 1_000);
    expect(pinExpiry).toBeLessThanOrEqual(Date.now() + 7 * 60 * 1_000);
    expect(releaseReleasePin).not.toHaveBeenCalled();

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

  test('releases a failed pin exchange so the same capability can retry', async () => {
    let attempts = 0;
    const acquireReleasePin = mock(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('catalog unavailable');
      }
      return { pinId: 'pin-retry' };
    });
    const releaseExchange = mock(async () => true);
    const completeExchange = mock(async () => true);
    const handler = createPackageInstallSessionRoute({
      accessPort: accessPort(),
      authorizationPort: {
        ...defaultAuthorizationPort,
        completeExchange,
        releaseExchange,
      },
      audience,
      issuer,
      keyId,
      privateKey,
      releasePins: {
        acquireReleasePin,
        releaseReleasePin: async () => undefined,
      },
      verificationBaseUrl,
      verifyAccessRequest: async () => ({
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
        ok: true,
      }),
    });
    const operation = await requestBody();

    expect((await handler(request(operation))).status).toBe(503);
    expect((await handler(request(operation))).status).toBe(200);
    expect(releaseExchange).toHaveBeenCalledTimes(1);
    expect(completeExchange).toHaveBeenCalledTimes(1);
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
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      releaseRoot: '11'.repeat(32),
      version: '1.0.0',
      versionId: 'version-jammr-100',
    }));
    const port = accessPort({ resolvePublication });
    const handler = createPackageInstallSessionRoute({
      accessPort: port,
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      verificationBaseUrl,
      keyId,
      privateKey,
      releasePins: defaultReleasePins,
      verifyAccessRequest: async () => ({
        ok: true,
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
      }),
    });

    const response = await handler(
      request({
        ...(await requestBody()),
        targetReleaseRoot: '11'.repeat(32),
      })
    );

    expect(response.status).toBe(200);
    expect(resolvePublication).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: 'com.yucp.jammr' }),
      'commercial',
      '11'.repeat(32)
    );
    expect(await response.json()).toMatchObject({
      releaseRoot: '11'.repeat(32),
      versionId: 'version-jammr-100',
    });
  });

  test('returns 403 before publication lookup when no storefront entitlement is active', async () => {
    const port = accessPort({ resolveEntitledEdition: mock(async () => null) });
    const handler = createPackageInstallSessionRoute({
      accessPort: port,
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      verificationBaseUrl,
      keyId,
      privateKey,
      releasePins: defaultReleasePins,
      verifyAccessRequest: async () => ({
        ok: true,
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
      }),
    });

    const response = await handler(request(await requestBody()));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      errorCode: 'ENTITLEMENT_REQUIRED',
      verificationUrl: 'https://app.example.test/access/catalog-jammr-gumroad',
    });
    expect(port.resolvePublication).not.toHaveBeenCalled();
  });

  test('accepts only HTTPS or loopback HTTP origins for verification routing', () => {
    const baseOptions = {
      accessPort: accessPort(),
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      verificationBaseUrl,
      keyId,
      privateKey,
      verifyAccessRequest: async () => ({
        ok: true as const,
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
      }),
    };

    expect(() =>
      createPackageInstallSessionRoute({
        ...baseOptions,
        verificationBaseUrl: 'http://app.example.test',
      })
    ).toThrow('verificationBaseUrl');
    expect(() =>
      createPackageInstallSessionRoute({
        ...baseOptions,
        verificationBaseUrl: 'https://app.example.test/untrusted-path',
      })
    ).toThrow('verificationBaseUrl');
    expect(() =>
      createPackageInstallSessionRoute({
        ...baseOptions,
        verificationBaseUrl: 'http://localhost:3000',
      })
    ).not.toThrow();
    expect(() =>
      createPackageInstallSessionRoute({
        ...baseOptions,
        verificationBaseUrl: 'https://app.example.test',
      })
    ).not.toThrow();
  });

  test('resolves a stale installed alias through stable package identity', async () => {
    const port = accessPort();
    const handler = createPackageInstallSessionRoute({
      accessPort: port,
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      verificationBaseUrl,
      keyId,
      privateKey,
      releasePins: defaultReleasePins,
      verifyAccessRequest: async () => ({
        ok: true,
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
      }),
    });

    const response = await handler(
      request({
        ...(await requestBody()),
        catalogProductIds: ['catalog-jammr-jinxxy'],
      })
    );
    expect(response.status).toBe(400);
    expect(port.resolveProductGroup).not.toHaveBeenCalled();
  });

  test('does not authorize another package when alias resolution returns a different identity', async () => {
    const resolveEntitledEdition = mock(async () => 'commercial');
    const port = accessPort({
      resolveEntitledEdition,
      resolveProductGroup: mock(async () => ({
        ...productGroup(),
        aliasId: 'com.yucp.another-package',
        packageId: 'com.yucp.another-package',
      })),
    });
    const handler = createPackageInstallSessionRoute({
      accessPort: port,
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      verificationBaseUrl,
      keyId,
      privateKey,
      releasePins: defaultReleasePins,
      verifyAccessRequest: async () => ({
        ok: true,
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
      }),
    });

    const response = await handler(request(await requestBody()));

    expect(response.status).toBe(404);
    expect(resolveEntitledEdition).not.toHaveBeenCalled();
  });

  test('rejects missing OAuth authorization', async () => {
    const handler = createPackageInstallSessionRoute({
      accessPort: accessPort(),
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      verificationBaseUrl,
      keyId,
      privateKey,
      releasePins: defaultReleasePins,
      verifyAccessRequest: async () => ({ ok: false, status: 401 }),
    });
    const response = await handler(request(await requestBody(), 'invalid'));
    expect(response.status).toBe(401);
  });

  test('creates one idempotent Linux materialization job for protected files', async () => {
    const createJob = mock(async (_input: unknown) => undefined);
    let outcome:
      | {
          deliveryGrantId: string;
          grantExpiresAt: Date;
          grantIssuedAt: Date;
          grantTokenSha256: string;
          materializationJobId?: string;
          renewableUntil: Date;
          sessionId: string;
          versionId: string;
        }
      | undefined;
    const authorizationPort: PackageOperationAuthorizationPort = {
      ...defaultAuthorizationPort,
      beginExchange: mock(async () => {
        if (outcome) {
          return {
            ...outcome,
            status: 'ready' as const,
          };
        }
        return { generation: 1, status: 'claimed' as const };
      }),
      completeExchange: mock(async (input) => {
        outcome = {
          deliveryGrantId: input.deliveryGrantId,
          grantExpiresAt: input.grantExpiresAt,
          grantIssuedAt: input.grantIssuedAt,
          grantTokenSha256: input.grantTokenSha256,
          ...(input.materializationJobId
            ? { materializationJobId: input.materializationJobId }
            : {}),
          renewableUntil: input.renewableUntil,
          sessionId: input.sessionId,
          versionId: input.versionId,
        };
        return true;
      }),
    };
    const acquireReleasePin = mock(
      async (_input: Parameters<PackageInstallReleasePinControl['acquireReleasePin']>[0]) => ({
        pinId: 'pin-materialization-1',
      })
    );
    const releaseReleasePin = mock(async () => undefined);
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
            required: false,
            sourceSha256: 'aa'.repeat(32),
          },
        ],
        protectedSourceRoot: '88'.repeat(32),
        protectionPolicyDigest: '99'.repeat(32),
        protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
        releaseRoot: '11'.repeat(32),
        version: '1.2.3',
        versionId: 'version-jammr-123',
      })),
    });
    const handler = createPackageInstallSessionRoute({
      accessPort: port,
      authorizationPort,
      audience,
      issuer,
      verificationBaseUrl,
      keyId,
      materializationControl: { createJob },
      privateKey,
      releasePins: { acquireReleasePin, releaseReleasePin },
      verifyAccessRequest: async () => ({
        ok: true,
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
      }),
    });

    const operationRequest = await requestBody();
    const first = await handler(request(operationRequest));
    const second = await handler(request(operationRequest));
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
    expect(secondBody.deliveryGrant).toBe(firstBody.deliveryGrant);
    expect(secondBody.materializationJobId).toBe(firstBody.materializationJobId);
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob.mock.calls[0]?.[0]).toMatchObject({
      buyerId: 'buyer-1',
      creatorId: 'creator-1',
      jobId: firstBody.materializationJobId,
      productId: 'com.yucp.jammr',
      sourceVersionId: 'version-jammr-123',
    });
    expect(acquireReleasePin).toHaveBeenCalledTimes(1);
    expect(acquireReleasePin.mock.calls[0]?.[0]).toMatchObject({
      ownerId: expect.stringMatching(/^session-/),
      packageVersionId: 'version-jammr-123',
      pinKind: 'delivery-binding',
    });
    expect(releaseReleasePin).not.toHaveBeenCalled();
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

  test('releases a failed materialization exchange so the same capability can retry', async () => {
    let jobAttempts = 0;
    const createJob = mock(async () => {
      jobAttempts += 1;
      if (jobAttempts === 1) {
        throw new Error('control plane unavailable');
      }
    });
    const releaseExchange = mock(async () => true);
    const completeExchange = mock(async () => true);
    const acquireReleasePin = mock(
      async (_input: Parameters<PackageInstallReleasePinControl['acquireReleasePin']>[0]) => ({
        pinId: 'pin-materialization-failed',
      })
    );
    const releaseReleasePin = mock(async () => undefined);
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
            required: false,
            sourceSha256: 'aa'.repeat(32),
          },
        ],
        protectedSourceRoot: '88'.repeat(32),
        protectionPolicyDigest: '99'.repeat(32),
        protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
        releaseRoot: '11'.repeat(32),
        version: '1.2.3',
        versionId: 'version-jammr-123',
      })),
    });
    const handler = createPackageInstallSessionRoute({
      accessPort: port,
      authorizationPort: {
        ...defaultAuthorizationPort,
        completeExchange,
        releaseExchange,
      },
      audience,
      issuer,
      verificationBaseUrl,
      keyId,
      materializationControl: { createJob },
      privateKey,
      releasePins: { acquireReleasePin, releaseReleasePin },
      verifyAccessRequest: async () => ({
        ok: true,
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
      }),
    });

    const operation = await requestBody();
    const first = await handler(request(operation));
    const second = await handler(request(operation));

    expect(first.status).toBe(503);
    expect(second.status).toBe(200);
    expect(releaseExchange).toHaveBeenCalledTimes(1);
    expect(completeExchange).toHaveBeenCalledTimes(1);
    expect(acquireReleasePin).toHaveBeenCalledTimes(2);
    expect(releaseReleasePin).toHaveBeenCalledTimes(1);
    expect(releaseReleasePin).toHaveBeenCalledWith({
      pinId: 'pin-materialization-failed',
    });
  });

  test('materializes protected preflight before the review plan can be issued', async () => {
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
            required: false,
            sourceSha256: 'aa'.repeat(32),
          },
        ],
        protectedSourceRoot: '88'.repeat(32),
        protectionPolicyDigest: '99'.repeat(32),
        protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
        releaseRoot: '11'.repeat(32),
        version: '1.2.3',
        versionId: 'version-jammr-123',
      })),
    });
    const handler = createPackageInstallSessionRoute({
      accessPort: port,
      authorizationPort: defaultAuthorizationPort,
      audience,
      issuer,
      verificationBaseUrl,
      keyId,
      materializationControl: { createJob },
      privateKey,
      releasePins: defaultReleasePins,
      verifyAccessRequest: async () => ({
        ok: true,
        buyerId: 'buyer-1',
        deviceKeyThumbprint,
      }),
    });

    const response = await handler(request(await requestBody({ operation: 'preflight' })));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      installSession: string;
      materializationJobId: string;
    };
    expect(body.materializationJobId).toMatch(/^job-/);
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob.mock.calls[0]?.[0]).toMatchObject({
      buyerId: 'buyer-1',
      creatorId: 'creator-1',
      jobId: body.materializationJobId,
      productId: 'com.yucp.jammr',
      sourceVersionId: 'version-jammr-123',
    });
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
      progress: {
        completedFiles: 25,
        completedLogicalBytes: 1_024,
        sequence: 7,
        stage: 'source_assembly' as const,
        status: 'progress' as const,
        totalFiles: 100,
        totalLogicalBytes: 4_096,
        updatedAt: '2033-05-18T03:33:20.000Z',
      },
      queuePosition: 0,
      state: 'MATERIALIZING' as const,
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
            required: false,
            sourceSha256: 'aa'.repeat(32),
          },
        ],
        protectedSourceRoot: '88'.repeat(32),
        protectionPolicyDigest: '99'.repeat(32),
        protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
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
      new Request('http://internal-api:3001/api/v2/package-installs/materialization-status', {
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
