import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ed25519 from '@noble/ed25519';
import { buildPackageContractGoldenVectors } from './packageContractGoldenVectors';
import {
  computeOutputTreeRootV2,
  type DeliveryGrantV2,
  decodeCanonicalPackageCbor,
  encodeDeliveryGrantV2,
  encodeInstallSessionV2,
  encodeMaterializationCapabilityV2,
  encodeMaterializationReceiptV2,
  encodePackageOperationCapabilityV2,
  hashPackageContractFields,
  INSTALL_SESSION_TOKEN_TYPE,
  type InstallSessionV2,
  type MaterializationJobCapabilityV2,
  type MaterializationReceiptV2,
  PACKAGE_CONTRACT_PURPOSES,
  type PackageOperationCapabilityV2,
  packageContractKeyId,
  signPackageContract,
  verifyDeliveryGrantV2,
  verifyInstallSessionV2,
  verifyMaterializationCapabilityV2,
  verifyMaterializationReceiptV2,
  verifyPackageContract,
  verifyPackageOperationCapabilityV2,
} from './packageContractsV2';

const PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const KEY_ID = packageContractKeyId('test-root-2026-01');
const DIGEST_A = new Uint8Array(32).fill(0x11);
const DIGEST_B = new Uint8Array(32).fill(0x22);
const DEVICE_KEY = new Uint8Array(32).fill(0x33);

function session(overrides: Partial<InstallSessionV2> = {}): InstallSessionV2 {
  return {
    aliasId: 'creator.avatar-tools',
    allowedApiOrigins: ['https://api.example.test'],
    allowedArtifactOrigins: ['https://delivery.example.test'],
    audience: 'yucp-unity-importer',
    bindingRoot: DIGEST_B,
    bootstrap: [
      {
        kind: 'release-descriptor',
        sha256: DIGEST_A,
        url: 'https://api.example.test/v2/releases/release-1',
      },
      {
        kind: 'delivery-binding',
        sha256: DIGEST_B,
        url: 'https://delivery.example.test/v2/bindings/binding-1',
      },
    ],
    buyerId: 'buyer-1',
    creatorId: 'creator-1',
    deviceKeyThumbprint: DEVICE_KEY,
    expiresAt: 1_800,
    issuedAt: 1_000,
    issuer: 'https://api.example.test',
    keyId: 'test-root-2026-01',
    maxLifetimeSeconds: 900,
    notBefore: 1_000,
    operation: 'install',
    productId: 'product-1',
    releaseRoot: DIGEST_A,
    sessionId: '018f8c03-3880-7d40-a8d5-b190a64141cc',
    tokenType: INSTALL_SESSION_TOKEN_TYPE,
    version: '1.2.3',
    ...overrides,
  };
}

function validationContext() {
  return {
    aliasId: 'creator.avatar-tools',
    allowedApiOrigins: ['https://api.example.test'],
    allowedArtifactOrigins: ['https://delivery.example.test'],
    audience: 'yucp-unity-importer',
    bindingRoot: DIGEST_B,
    deviceKeyThumbprint: DEVICE_KEY,
    issuer: 'https://api.example.test',
    now: 1_200,
    operation: 'install' as const,
    releaseRoot: DIGEST_A,
  };
}

function deliveryGrant(overrides: Partial<DeliveryGrantV2> = {}): DeliveryGrantV2 {
  return {
    audience: 'yucp-materialization-source',
    bindingRoot: DIGEST_B,
    buyerId: 'data-node-1',
    creatorId: 'creator-1',
    deviceKeyThumbprint: DEVICE_KEY,
    expiresAt: 1_300,
    grantId: 'source-grant-1',
    installSessionId: 'job-1',
    issuedAt: 1_000,
    issuer: 'https://api.example.test',
    notBefore: 1_000,
    productId: 'product-1',
    releaseRoot: DIGEST_A,
    scopes: ['materialization-source:version-1'],
    ...overrides,
  };
}

function packageOperationCapability(
  overrides: Partial<PackageOperationCapabilityV2> = {}
): PackageOperationCapabilityV2 {
  return {
    aliasId: 'creator.avatar-tools',
    approvedActiveContentDigest: DIGEST_A,
    approvedPolicyVersion: 'active-content-policy-v1',
    audience: 'https://api.example.test',
    buyerId: 'buyer-1',
    capabilityId: 'operation-capability-1',
    deviceKeyThumbprint: DEVICE_KEY,
    expectedCurrentReleaseRoot: DIGEST_B,
    expiresAt: 1_240,
    idempotencyKey: 'install-operation-1',
    issuedAt: 1_000,
    issuer: 'https://api.example.test',
    notBefore: 1_000,
    oneUseNonce: new Uint8Array(32).fill(0x55),
    operation: 'install',
    projectIdentity: new Uint8Array(32).fill(0x44),
    releaseRoot: DIGEST_A,
    traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    ...overrides,
  };
}

function materializationCapability(
  overrides: Partial<MaterializationJobCapabilityV2> = {}
): MaterializationJobCapabilityV2 {
  return {
    buyerSubjectPseudonym: 'buyer-pseudonym-1',
    capabilityId: 'capability-1',
    creatorId: 'creator-1',
    expiresAt: 1_300,
    grantJti: 'grant-1',
    issuedAt: 1_000,
    jobId: 'job-1',
    keyEpoch: 1,
    leaseGeneration: 3,
    materializationAlgorithm: 'png-dct-qim-v2',
    oneUseNonce: new Uint8Array(32).fill(0x44),
    outputFormat: 'overlay',
    pluginVersion: 'png-plugin-2',
    productId: 'product-1',
    proofKeyThumbprint: DEVICE_KEY,
    protectedFiles: [
      {
        materializerType: 'image/png',
        normalizedPath: 'Assets/Product/protected.png',
        required: true,
        sourceSha256: new Uint8Array(32).fill(0x55),
      },
    ],
    protectedSourceRoot: DIGEST_B,
    pseudonymMethod: 'hmac-sha256-v1',
    releaseRoot: DIGEST_A,
    ...overrides,
  };
}

function materializationReceipt(): MaterializationReceiptV2 {
  const outputFiles = [
    {
      attributionId: 'attribution-1',
      normalizedPath: 'Assets/Product/protected.png',
      outputBytes: 1_024,
      outputSha256: new Uint8Array(32).fill(0x66),
    },
  ];
  return {
    buyerSubjectPseudonym: 'buyer-pseudonym-1',
    capabilityId: 'capability-1',
    codecBuild: 'codec-1',
    createdPaths: outputFiles.map((file) => file.normalizedPath),
    creatorId: 'creator-1',
    expiresAt: 2_000,
    grantId: 'grant-1',
    helperBuild: 'helper-1',
    issuedAt: 1_100,
    jobId: 'job-1',
    keyEpoch: 1,
    leaseGeneration: 3,
    materializationAlgorithm: 'png-dct-qim-v2',
    materializerId: 'materializer-1',
    outputFiles,
    outputTreeRoot: computeOutputTreeRootV2(outputFiles),
    pluginVersion: 'png-plugin-2',
    productId: 'product-1',
    protectedSourceRoot: new Uint8Array(32).fill(0x22),
    pseudonymMethod: 'hmac-sha256-v1',
    receiptId: 'receipt-1',
    releaseRoot: DIGEST_A,
    rendition: {
      bucketName: 'yucp-renditions-test',
      fileIdentifier: '01JFILEID',
      objectBytes: 2_048,
      objectKey: 'personalized/release-1/buyer-pseudonym-1.zip',
      objectSha256: new Uint8Array(32).fill(0x77),
      providerVersion: '01JVERSION',
      storageRole: 'renditions',
    },
    runtimeBuild: 'runtime-1',
    traceId: 'trace-1',
  };
}

describe('package contracts v2', () => {
  test('purpose-separates and binds one package operation capability', async () => {
    const capability = packageOperationCapability();
    const signed = await signPackageContract({
      keyId: KEY_ID,
      payload: encodePackageOperationCapabilityV2(capability),
      privateKey: PRIVATE_KEY,
      purpose: PACKAGE_CONTRACT_PURPOSES.packageOperationCapability,
    });
    const publicKey = await ed25519.getPublicKeyAsync(PRIVATE_KEY);

    await expect(
      verifyPackageOperationCapabilityV2({
        context: {
          aliasId: capability.aliasId,
          approvedActiveContentDigest: capability.approvedActiveContentDigest,
          approvedPolicyVersion: capability.approvedPolicyVersion,
          audience: capability.audience,
          deviceKeyThumbprint: capability.deviceKeyThumbprint,
          expectedCurrentReleaseRoot: capability.expectedCurrentReleaseRoot,
          idempotencyKey: capability.idempotencyKey,
          issuer: capability.issuer,
          now: 1_100,
          operation: capability.operation,
          projectIdentity: capability.projectIdentity,
          releaseRoot: capability.releaseRoot,
          traceparent: capability.traceparent,
        },
        coseSign1: signed.coseSign1,
        expectedKeyId: KEY_ID,
        publicKey,
      })
    ).resolves.toMatchObject({
      capabilityId: capability.capabilityId,
      idempotencyKey: capability.idempotencyKey,
    });

    await expect(
      verifyPackageContract({
        coseSign1: signed.coseSign1,
        expectedKeyId: KEY_ID,
        expectedPurpose: PACKAGE_CONTRACT_PURPOSES.installSession,
        publicKey,
      })
    ).rejects.toThrow('purpose');
  });
  test('uses the frozen length-prefixed package hash framing', () => {
    expect(
      Buffer.from(
        hashPackageContractFields('yucp:chunk:v2', [new TextEncoder().encode('abc')])
      ).toString('hex')
    ).toBe('55667f9928396d23fe784fdaee6e73c5317d775214d770878e7f7d623214db3a');
    expect(() => hashPackageContractFields('chunk', [])).toThrow('versioned ASCII YUCP purpose');
  });

  test('verifies a bound install session and rejects a different signature purpose', async () => {
    const publicKey = await ed25519.getPublicKeyAsync(PRIVATE_KEY);
    const payload = encodeInstallSessionV2(session());
    const signed = await signPackageContract({
      keyId: KEY_ID,
      payload,
      privateKey: PRIVATE_KEY,
      purpose: PACKAGE_CONTRACT_PURPOSES.installSession,
    });

    await expect(
      verifyInstallSessionV2({
        context: validationContext(),
        coseSign1: signed.coseSign1,
        expectedKeyId: KEY_ID,
        publicKey,
      })
    ).resolves.toEqual(session());
    await expect(
      verifyPackageContract({
        coseSign1: signed.coseSign1,
        expectedPurpose: PACKAGE_CONTRACT_PURPOSES.deliveryGrant,
        publicKey,
      })
    ).rejects.toThrow('purpose does not match');
  });

  test('binds a delivery grant to one proof key and exact source scope', async () => {
    const publicKey = await ed25519.getPublicKeyAsync(PRIVATE_KEY);
    const signed = await signPackageContract({
      keyId: KEY_ID,
      payload: encodeDeliveryGrantV2(deliveryGrant()),
      privateKey: PRIVATE_KEY,
      purpose: PACKAGE_CONTRACT_PURPOSES.deliveryGrant,
    });

    await expect(
      verifyDeliveryGrantV2({
        context: {
          audience: 'yucp-materialization-source',
          deviceKeyThumbprint: DEVICE_KEY,
          issuer: 'https://api.example.test',
          now: 1_100,
          requiredScope: 'materialization-source:version-1',
        },
        coseSign1: signed.coseSign1,
        expectedKeyId: KEY_ID,
        publicKey,
      })
    ).resolves.toEqual(deliveryGrant());
    await expect(
      verifyDeliveryGrantV2({
        context: {
          audience: 'yucp-materialization-source',
          deviceKeyThumbprint: DEVICE_KEY,
          issuer: 'https://api.example.test',
          now: 1_100,
          requiredScope: 'materialization-source:version-2',
        },
        coseSign1: signed.coseSign1,
        expectedKeyId: KEY_ID,
        publicKey,
      })
    ).rejects.toThrow('scope is not bound to the requested delivery');
  });

  test('rejects noncanonical CBOR and swapped install origins', async () => {
    expect(() => decodeCanonicalPackageCbor(Uint8Array.of(0x18, 0x01))).toThrow();
    const publicKey = await ed25519.getPublicKeyAsync(PRIVATE_KEY);
    const signed = await signPackageContract({
      keyId: KEY_ID,
      payload: encodeInstallSessionV2(session()),
      privateKey: PRIVATE_KEY,
      purpose: PACKAGE_CONTRACT_PURPOSES.installSession,
    });
    await expect(
      verifyInstallSessionV2({
        context: {
          ...validationContext(),
          allowedArtifactOrigins: ['https://swapped.example.test'],
        },
        coseSign1: signed.coseSign1,
        expectedKeyId: KEY_ID,
        publicKey,
      })
    ).rejects.toThrow('origin binding is invalid');
  });

  test('rejects expired and misplaced install sessions', async () => {
    const publicKey = await ed25519.getPublicKeyAsync(PRIVATE_KEY);
    const signed = await signPackageContract({
      keyId: KEY_ID,
      payload: encodeInstallSessionV2(session()),
      privateKey: PRIVATE_KEY,
      purpose: PACKAGE_CONTRACT_PURPOSES.installSession,
    });
    await expect(
      verifyInstallSessionV2({
        context: { ...validationContext(), now: 1_800 },
        coseSign1: signed.coseSign1,
        expectedKeyId: KEY_ID,
        publicKey,
      })
    ).rejects.toThrow('is not active');
    await expect(
      verifyInstallSessionV2({
        context: { ...validationContext(), aliasId: 'creator.other-product' },
        coseSign1: signed.coseSign1,
        expectedKeyId: KEY_ID,
        publicKey,
      })
    ).rejects.toThrow('not bound');
  });

  test('binds a signed materialization receipt to the exact rendition version', async () => {
    const publicKey = await ed25519.getPublicKeyAsync(PRIVATE_KEY);
    const receipt = materializationReceipt();
    const signed = await signPackageContract({
      keyId: KEY_ID,
      payload: encodeMaterializationReceiptV2(receipt),
      privateKey: PRIVATE_KEY,
      purpose: PACKAGE_CONTRACT_PURPOSES.materializationReceipt,
    });

    await expect(
      verifyMaterializationReceiptV2({
        coseSign1: signed.coseSign1,
        expectedKeyId: KEY_ID,
        publicKey,
      })
    ).resolves.toEqual(receipt);
    expect(() =>
      encodeMaterializationReceiptV2({
        ...receipt,
        rendition: { ...receipt.rendition, providerVersion: '' },
      })
    ).toThrow('providerVersion');
  });

  test('binds a one-use materialization capability to its job and proof key', async () => {
    const publicKey = await ed25519.getPublicKeyAsync(PRIVATE_KEY);
    const capability = materializationCapability();
    const signed = await signPackageContract({
      keyId: KEY_ID,
      payload: encodeMaterializationCapabilityV2(capability),
      privateKey: PRIVATE_KEY,
      purpose: PACKAGE_CONTRACT_PURPOSES.materializationCapability,
    });

    await expect(
      verifyMaterializationCapabilityV2({
        coseSign1: signed.coseSign1,
        expectedKeyId: KEY_ID,
        publicKey,
      })
    ).resolves.toEqual(capability);
    expect(() =>
      encodeMaterializationCapabilityV2({
        ...capability,
        protectedFiles: [...capability.protectedFiles, { ...capability.protectedFiles[0] }],
      })
    ).toThrow('strict UTF-8 path order');
    expect(() =>
      encodeMaterializationCapabilityV2({
        ...capability,
        expiresAt: capability.issuedAt + 901,
      })
    ).toThrow('maximum lifetime');
  });

  test('keeps the checked-in golden vectors current', async () => {
    const expected = JSON.parse(
      await readFile(join(import.meta.dir, 'fixtures', 'package-contracts-v2.json'), 'utf8')
    );
    expect(await buildPackageContractGoldenVectors()).toEqual(expected);
  });
});
