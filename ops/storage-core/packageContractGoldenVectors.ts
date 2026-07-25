import { createHash } from 'node:crypto';
import * as ed25519 from '@noble/ed25519';
import {
  computeOutputTreeRootV2,
  type DeliveryGrantV2,
  encodeCanonicalPackageCbor,
  encodeDeliveryGrantV2,
  encodeInstallSessionV2,
  encodeMaterializationCapabilityV2,
  encodeMaterializationReceiptV2,
  INSTALL_SESSION_TOKEN_TYPE,
  type InstallSessionV2,
  type MaterializationJobCapabilityV2,
  type MaterializationReceiptV2,
  PACKAGE_CONTRACT_PURPOSES,
  type PackageContractCborValue,
  type PackageContractPurpose,
  packageContractKeyId,
  signPackageContract,
} from './packageContractsV2';

const PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const KEY_ID = packageContractKeyId('test-root-2026-01');

function digest(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function cborMap(
  entries: Array<[number, PackageContractCborValue]>
): Map<number, PackageContractCborValue> {
  return new Map(entries);
}

function sampleInstallSession(): InstallSessionV2 {
  return {
    aliasId: 'creator.avatar-tools',
    allowedApiOrigins: ['https://api.example.test'],
    allowedArtifactOrigins: ['https://delivery.example.test'],
    audience: 'yucp-unity-importer',
    bindingRoot: digest(0x22),
    bootstrap: [
      {
        kind: 'release-descriptor',
        sha256: digest(0x11),
        url: 'https://api.example.test/v2/releases/release-1',
      },
      {
        kind: 'delivery-binding',
        sha256: digest(0x22),
        url: 'https://delivery.example.test/v2/bindings/binding-1',
      },
    ],
    buyerId: 'buyer-1',
    creatorId: 'creator-1',
    deviceKeyThumbprint: digest(0x33),
    expiresAt: 1_800,
    issuedAt: 1_000,
    issuer: 'https://api.example.test',
    keyId: 'test-root-2026-01',
    maxLifetimeSeconds: 900,
    notBefore: 1_000,
    operation: 'install',
    productId: 'product-1',
    releaseRoot: digest(0x11),
    sessionId: '018f8c03-3880-7d40-a8d5-b190a64141cc',
    tokenType: INSTALL_SESSION_TOKEN_TYPE,
    version: '1.2.3',
  };
}

function sampleDeliveryGrant(): DeliveryGrantV2 {
  return {
    audience: 'yucp-delivery',
    bindingRoot: digest(0x22),
    buyerId: 'buyer-1',
    creatorId: 'creator-1',
    deviceKeyThumbprint: digest(0x33),
    expiresAt: 1_300,
    grantId: 'grant-1',
    installSessionId: '018f8c03-3880-7d40-a8d5-b190a64141cc',
    issuedAt: 1_000,
    issuer: 'https://api.example.test',
    notBefore: 1_000,
    productId: 'product-1',
    releaseRoot: digest(0x11),
    scopes: ['chunks:read', 'metadata:read'],
  };
}

function sampleMaterializationReceipt(): MaterializationReceiptV2 {
  const outputFiles = [
    {
      attributionId: 'watermark-1',
      normalizedPath: 'Assets/Product/protected.png',
      outputBytes: 1_024,
      outputSha256: digest(0x66),
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
    protectedSourceRoot: digest(0x22),
    pseudonymMethod: 'hmac-sha256-v1',
    receiptId: 'receipt-1',
    releaseRoot: digest(0x11),
    rendition: {
      bucketName: 'yucp-renditions-test',
      fileIdentifier: '01JFILEID',
      objectBytes: 2_048,
      objectKey: 'personalized/release-1/buyer-pseudonym-1.zip',
      objectSha256: digest(0x77),
      providerVersion: '01JVERSION',
      storageRole: 'renditions',
    },
    runtimeBuild: 'runtime-1',
    traceId: 'trace-1',
  };
}

function sampleMaterializationCapability(): MaterializationJobCapabilityV2 {
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
    oneUseNonce: digest(0x44),
    outputFormat: 'overlay',
    pluginVersion: 'png-plugin-2',
    productId: 'product-1',
    proofKeyThumbprint: digest(0x33),
    protectedFiles: [
      {
        materializerType: 'image/png',
        normalizedPath: 'Assets/Product/protected.png',
        required: true,
        sourceSha256: digest(0x55),
      },
    ],
    protectedSourceRoot: digest(0x22),
    pseudonymMethod: 'hmac-sha256-v1',
    releaseRoot: digest(0x11),
  };
}

function samplePayload(purpose: PackageContractPurpose): Map<number, PackageContractCborValue> {
  const chunkRecipe = [
    new Map<number, PackageContractCborValue>([
      [0, digest(0x44)],
      [1, 65_536],
      [2, 0],
      [3, 65_536],
      [4, digest(0x55)],
    ]),
  ];
  switch (purpose) {
    case PACKAGE_CONTRACT_PURPOSES.releaseDescriptor:
      return cborMap([
        [0, 2],
        [1, 'creator-1'],
        [2, 'product-1'],
        [3, 'release-1'],
        [4, '1.2.3'],
        [5, digest(0x11)],
        [6, digest(0x22)],
        [7, digest(0x33)],
        [8, digest(0x44)],
        [9, 'active-content-policy-v1'],
        [10, 1_000],
      ]);
    case PACKAGE_CONTRACT_PURPOSES.fileTableIndex:
      return cborMap([
        [0, 2],
        [1, digest(0x11)],
        [
          2,
          [
            cborMap([
              [0, 'Assets/'],
              [1, 'Packages/'],
              [2, digest(0x22)],
              [3, 512],
              [4, 1],
            ]),
          ],
        ],
      ]);
    case PACKAGE_CONTRACT_PURPOSES.fileTableShard:
      return cborMap([
        [0, 2],
        [1, digest(0x11)],
        [
          2,
          [
            cborMap([
              [0, 'Assets/Product/shader.shader'],
              [1, 65_536],
              [2, digest(0x33)],
              [3, 0],
              [4, chunkRecipe],
            ]),
          ],
        ],
      ]);
    case PACKAGE_CONTRACT_PURPOSES.membershipIndex:
      return cborMap([
        [0, 2],
        [1, digest(0x11)],
        [
          2,
          [
            cborMap([
              [0, digest(0x00)],
              [1, digest(0xff)],
              [2, digest(0x22)],
              [3, 1],
            ]),
          ],
        ],
      ]);
    case PACKAGE_CONTRACT_PURPOSES.membershipShard:
      return cborMap([
        [0, 2],
        [1, digest(0x11)],
        [
          2,
          [
            cborMap([
              [0, digest(0x44)],
              [1, 65_536],
              [2, 0],
            ]),
          ],
        ],
      ]);
    case PACKAGE_CONTRACT_PURPOSES.deliveryBinding:
      return cborMap([
        [0, 2],
        [1, digest(0x22)],
        [2, digest(0x11)],
        [3, 1],
        [4, '64:256:1024'],
        [5, 'https://common.example.test'],
        [6, 'https://protected.example.test'],
        [7, 'https://metadata.example.test'],
        [8, 1_000],
      ]);
    case PACKAGE_CONTRACT_PURPOSES.deliveryGrant:
      throw new Error('DeliveryGrantV2 uses its typed golden payload');
    case PACKAGE_CONTRACT_PURPOSES.materializationCapability:
      throw new Error('MaterializationJobCapabilityV2 uses its typed golden payload');
    case PACKAGE_CONTRACT_PURPOSES.activeContentInventory:
      return cborMap([
        [0, 2],
        [1, digest(0x11)],
        [2, digest(0x44)],
        [3, 'active-content-policy-v1'],
        [
          4,
          [
            cborMap([
              [0, 'Assets/Product/Editor/Install.cs'],
              [1, digest(0x33)],
              [2, 'unity-editor-script'],
            ]),
          ],
        ],
      ]);
    case PACKAGE_CONTRACT_PURPOSES.materializationReceipt:
      throw new Error('MaterializationReceiptV2 uses its typed golden payload');
    case PACKAGE_CONTRACT_PURPOSES.installSession:
      throw new Error('InstallSessionV2 uses its typed golden payload');
  }
}

export async function buildPackageContractGoldenVectors() {
  const publicKey = await ed25519.getPublicKeyAsync(PRIVATE_KEY);
  const vectors = [];
  for (const purpose of Object.values(PACKAGE_CONTRACT_PURPOSES)) {
    const payload =
      purpose === PACKAGE_CONTRACT_PURPOSES.installSession
        ? encodeInstallSessionV2(sampleInstallSession())
        : purpose === PACKAGE_CONTRACT_PURPOSES.deliveryGrant
          ? encodeDeliveryGrantV2(sampleDeliveryGrant())
          : purpose === PACKAGE_CONTRACT_PURPOSES.materializationCapability
            ? encodeMaterializationCapabilityV2(sampleMaterializationCapability())
            : purpose === PACKAGE_CONTRACT_PURPOSES.materializationReceipt
              ? encodeMaterializationReceiptV2(sampleMaterializationReceipt())
              : encodeCanonicalPackageCbor(samplePayload(purpose));
    const signed = await signPackageContract({
      keyId: KEY_ID,
      payload,
      privateKey: PRIVATE_KEY,
      purpose,
    });
    vectors.push({
      coseSign1Hex: toHex(signed.coseSign1),
      coseSign1Sha256: createHash('sha256').update(signed.coseSign1).digest('hex'),
      payloadHex: toHex(payload),
      payloadSha256: createHash('sha256').update(payload).digest('hex'),
      purpose,
    });
  }
  return {
    keyIdHex: toHex(KEY_ID),
    publicKeyHex: toHex(publicKey),
    schemaVersion: 1,
    vectors,
  };
}
