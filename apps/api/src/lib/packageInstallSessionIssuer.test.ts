import { describe, expect, test } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import {
  PACKAGE_CONTRACT_PURPOSES,
  verifyDeliveryGrantV2,
  verifyInstallSessionV2,
} from '../../../../ops/storage-core/packageContractsV2';
import { ACTIVE_PROTECTION_POLICY_ID } from '../../../../ops/storage-core/protectionPolicyId';
import {
  issuePackageInstallSession,
  type PackageInstallPublication,
} from './packageInstallSessionIssuer';

const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const keyId = 'install-session-test-1';
const issuer = 'https://api.example.test';
const audience = 'https://delivery.example.test';
const releaseRoot = '11'.repeat(32);
const bindingRoot = '22'.repeat(32);
const manifestSha256 = '33'.repeat(32);
const deviceKeyThumbprint = '44'.repeat(32);

function publication(
  overrides: Partial<PackageInstallPublication> = {}
): PackageInstallPublication {
  return {
    activeContentDigest: '66'.repeat(32),
    activePolicyVersion: 'active-content-policy-v1',
    aliasId: 'jammr',
    bindingRoot,
    catalogProductIds: ['catalog-jammr-gumroad', 'catalog-jammr-jinxxy'],
    commonRoot: '77'.repeat(32),
    creatorId: 'creator-1',
    logicalBytes: 42_000,
    logicalFiles: 12,
    manifestSha256,
    packageId: 'com.yucp.jammr',
    protectedFiles: [],
    protectedSourceRoot: '88'.repeat(32),
    protectionPolicyDigest: '99'.repeat(32),
    protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
    releaseRoot,
    version: '1.2.3',
    versionId: 'version-jammr-123',
    ...overrides,
  };
}

describe('issuePackageInstallSession', () => {
  test('binds the signed session and delivery grant to one publication and device', async () => {
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const now = 2_000_000_000;
    const issued = await issuePackageInstallSession({
      audience,
      buyerId: 'buyer-1',
      deliveryGrantId: 'grant-1',
      deviceKeyThumbprint,
      issuer,
      keyId,
      now,
      operation: 'install',
      privateKey,
      publication: publication(),
      sessionId: 'session-1',
    });

    expect(issued.versionId).toBe('version-jammr-123');
    expect(issued).not.toHaveProperty('logicalBytes');
    expect(issued).not.toHaveProperty('logicalFiles');
    expect(issued.installSessionPurpose).toBe(PACKAGE_CONTRACT_PURPOSES.installSession);
    expect(issued.deliveryGrantPurpose).toBe(PACKAGE_CONTRACT_PURPOSES.deliveryGrant);

    const session = await verifyInstallSessionV2({
      coseSign1: issued.installSession,
      expectedKeyId: new TextEncoder().encode(keyId),
      publicKey,
      context: {
        aliasId: 'jammr',
        allowedApiOrigins: [issuer],
        allowedArtifactOrigins: [audience],
        audience,
        bindingRoot: Uint8Array.from(Buffer.from(bindingRoot, 'hex')),
        deviceKeyThumbprint: Uint8Array.from(Buffer.from(deviceKeyThumbprint, 'hex')),
        issuer,
        now: now + 1,
        operation: 'install',
        releaseRoot: Uint8Array.from(Buffer.from(releaseRoot, 'hex')),
      },
    });
    expect(session.bootstrap).toEqual([
      {
        kind: 'logical-tree-manifest-v4',
        sha256: Uint8Array.from(Buffer.from(manifestSha256, 'hex')),
        url: `${audience}/v2/delivery/version-jammr-123/manifest`,
      },
    ]);
    expect(session.productId).toBe('com.yucp.jammr');

    const grant = await verifyDeliveryGrantV2({
      coseSign1: issued.deliveryGrant,
      expectedKeyId: new TextEncoder().encode(keyId),
      publicKey,
      context: {
        audience,
        deviceKeyThumbprint: Uint8Array.from(Buffer.from(deviceKeyThumbprint, 'hex')),
        issuer,
        now: now + 1,
        requiredScope: 'package:version-jammr-123:read',
      },
    });
    expect(grant.installSessionId).toBe(session.sessionId);
    expect(grant.releaseRoot).toEqual(session.releaseRoot);
    expect(grant.bindingRoot).toEqual(session.bindingRoot);
  });

  test('rejects malformed roots before signing', async () => {
    await expect(
      issuePackageInstallSession({
        audience,
        buyerId: 'buyer-1',
        deliveryGrantId: 'grant-1',
        deviceKeyThumbprint,
        issuer,
        keyId,
        now: 2_000_000_000,
        operation: 'install',
        privateKey,
        publication: publication({ releaseRoot: 'not-a-digest' }),
        sessionId: 'session-1',
      })
    ).rejects.toThrow('releaseRoot');
  });

  test('rejects a non-origin delivery audience', async () => {
    await expect(
      issuePackageInstallSession({
        audience: 'https://delivery.example.test/path',
        buyerId: 'buyer-1',
        deliveryGrantId: 'grant-1',
        deviceKeyThumbprint,
        issuer,
        keyId,
        now: 2_000_000_000,
        operation: 'install',
        privateKey,
        publication: publication(),
        sessionId: 'session-1',
      })
    ).rejects.toThrow('audience');
  });

  test('adds one exact materialization scope for a protected publication', async () => {
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const issued = await issuePackageInstallSession({
      audience,
      buyerId: 'buyer-1',
      deliveryGrantId: 'grant-protected-1',
      deviceKeyThumbprint,
      issuer,
      keyId,
      materializationJobId: 'job-protected-1',
      now: 2_000_000_000,
      operation: 'install',
      privateKey,
      publication: publication({
        protectedFiles: [
          {
            materializerType: 'png',
            normalizedPath: 'Assets/Jammr/a.png',
            required: false,
            sourceSha256: 'aa'.repeat(32),
          },
        ],
      }),
      sessionId: 'session-protected-1',
    });
    const grant = await verifyDeliveryGrantV2({
      coseSign1: issued.deliveryGrant,
      expectedKeyId: new TextEncoder().encode(keyId),
      publicKey,
      context: {
        audience,
        deviceKeyThumbprint: Uint8Array.from(Buffer.from(deviceKeyThumbprint, 'hex')),
        issuer,
        now: 2_000_000_001,
        requiredScope: 'materialization:job-protected-1:read',
      },
    });
    expect(grant.grantId).toBe('grant-protected-1');
    expect(grant.scopes).toEqual([
      'materialization:job-protected-1:read',
      'package:version-jammr-123:read',
    ]);
    expect(issued.materializationJobId).toBe('job-protected-1');
  });

  test('issues a protected uninstall without materialization scope', async () => {
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const now = 2_000_000_000;
    const issued = await issuePackageInstallSession({
      audience,
      buyerId: 'buyer-1',
      deliveryGrantId: 'grant-protected-uninstall',
      deviceKeyThumbprint,
      issuer,
      keyId,
      now,
      operation: 'uninstall',
      privateKey,
      publication: publication({
        protectedFiles: [
          {
            materializerType: 'png',
            normalizedPath: 'Assets/Jammr/a.png',
            required: false,
            sourceSha256: 'aa'.repeat(32),
          },
        ],
      }),
      sessionId: 'session-protected-uninstall',
    });
    const grant = await verifyDeliveryGrantV2({
      coseSign1: issued.deliveryGrant,
      expectedKeyId: new TextEncoder().encode(keyId),
      publicKey,
      context: {
        audience,
        deviceKeyThumbprint: Uint8Array.from(Buffer.from(deviceKeyThumbprint, 'hex')),
        issuer,
        now: now + 1,
        requiredScope: 'package:version-jammr-123:read',
      },
    });

    expect(issued).not.toHaveProperty('materializationJobId');
    expect(grant.scopes).toEqual(['package:version-jammr-123:read']);
  });
});
