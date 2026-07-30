import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import * as ed25519 from '@noble/ed25519';
import {
  computeOutputTreeRootV2,
  decodeCanonicalPackageCbor,
  type MaterializedFileV2,
  PACKAGE_COSE_PURPOSE_HEADER,
  type PackageContractPurpose,
  packageContractKeyId,
  signPackageContract,
  verifyMaterializationReceiptV2,
} from '../storage-core/packageContractsV2';
import {
  encodeMaterializationReceiptV3,
  MATERIALIZATION_RECEIPT_V3_MAX_OUTPUT_FILES,
  MATERIALIZATION_RECEIPT_V3_PURPOSE,
  type MaterializationReceiptV3,
  verifyMaterializationReceiptV3,
} from './materializationReceiptV3';

const receiptPrivateKey = new Uint8Array(32).fill(0x47);
const receiptKeyId = packageContractKeyId('receipt-test-2026-01');
const nowSeconds = 2_000_000_000;

function outputFiles(count: number): MaterializedFileV2[] {
  return Array.from({ length: count }, (_, index) => ({
    attributionId: `attribution-${index.toString(16).padStart(4, '0')}`,
    normalizedPath: `Assets/Product/${index.toString(16).padStart(4, '0')}.png`,
    outputBytes: index + 1,
    outputSha256: createHash('sha256').update(`file-${index}`).digest(),
  }));
}

function receiptFixture(files: MaterializedFileV2[]): MaterializationReceiptV3 {
  return {
    buyerSubjectPseudonym: 'buyer-pseudonym-1',
    capabilityId: 'capability-1',
    codecBuild: 'codec-build-1',
    createdPaths: files.map((file) => file.normalizedPath),
    creatorId: 'creator-1',
    expiresAt: nowSeconds + 7 * 24 * 60 * 60,
    grantId: 'grant-coupled-1',
    helperBuild: 'helper-build-1',
    issuedAt: nowSeconds,
    jobId: 'job-coupled-1',
    keyEpoch: 7,
    leaseGeneration: 1,
    materializationAlgorithm: 'png-dct-qim-v2',
    materializerId: 'linux-data-node-1',
    outputFiles: files,
    outputTreeRoot: computeOutputTreeRootV2(files),
    pluginVersion: 'png-plugin-2',
    productId: 'com.yucp.jammr',
    protectedSourceRoot: new Uint8Array(32).fill(0x33),
    pseudonymMethod: 'hmac-sha256-hkdf-v2',
    receiptId: 'receipt-coupled-1',
    releaseRoot: new Uint8Array(32).fill(0x11),
    runtimeBuild: 'runtime-build-1',
    traceId: 'trace-coupled-1',
  };
}

async function signReceipt(receipt: MaterializationReceiptV3) {
  return signPackageContract({
    keyId: receiptKeyId,
    payload: encodeMaterializationReceiptV3(receipt),
    privateKey: receiptPrivateKey,
    purpose: MATERIALIZATION_RECEIPT_V3_PURPOSE as PackageContractPurpose,
  });
}

describe('materialization receipt v3', () => {
  it('signs a decodable coupled receipt without the rendition label under the v3 purpose', async () => {
    const files = outputFiles(3);
    const receipt = receiptFixture(files);
    const signed = await signReceipt(receipt);

    const envelope = decodeCanonicalPackageCbor(signed.coseSign1);
    if (!Array.isArray(envelope)) {
      throw new Error('COSE_Sign1 must be an array');
    }
    const protectedHeaders = decodeCanonicalPackageCbor(envelope[0] as Uint8Array);
    if (!(protectedHeaders instanceof Map)) {
      throw new Error('Protected headers must be a map');
    }
    expect(protectedHeaders.get(PACKAGE_COSE_PURPOSE_HEADER)).toBe('materialization-receipt-v3');

    const payload = decodeCanonicalPackageCbor(signed.payload);
    if (!(payload instanceof Map)) {
      throw new Error('Receipt payload must be a map');
    }
    const labels = [...payload.keys()];
    expect(labels).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
    ]);
    expect(payload.has(14)).toBeFalse();

    const decoded = await verifyMaterializationReceiptV3({
      coseSign1: signed.coseSign1,
      expectedKeyId: receiptKeyId,
      publicKey: await ed25519.getPublicKeyAsync(receiptPrivateKey),
    });
    expect(decoded).not.toHaveProperty('rendition');
    expect(decoded.receiptId).toBe('receipt-coupled-1');
    expect(decoded.jobId).toBe('job-coupled-1');
    expect(decoded.grantId).toBe('grant-coupled-1');
    expect(decoded.createdPaths).toEqual(files.map((file) => file.normalizedPath));
    expect(Buffer.from(decoded.outputTreeRoot)).toEqual(
      Buffer.from(computeOutputTreeRootV2(files))
    );
  });

  it('caps output files at 4096 instead of the v2 512', async () => {
    expect(MATERIALIZATION_RECEIPT_V3_MAX_OUTPUT_FILES).toBe(4_096);

    const beyondV2 = outputFiles(513);
    const signed = await signReceipt(receiptFixture(beyondV2));
    const decoded = await verifyMaterializationReceiptV3({
      coseSign1: signed.coseSign1,
      expectedKeyId: receiptKeyId,
      publicKey: await ed25519.getPublicKeyAsync(receiptPrivateKey),
    });
    expect(decoded.outputFiles).toHaveLength(513);

    expect(() => encodeMaterializationReceiptV3(receiptFixture(outputFiles(4_096)))).not.toThrow();
    expect(() => encodeMaterializationReceiptV3(receiptFixture(outputFiles(4_097)))).toThrow(
      'output file count'
    );
    expect(() =>
      encodeMaterializationReceiptV3({ ...receiptFixture(outputFiles(1)), outputFiles: [] })
    ).toThrow('output file count');
  }, 30_000);

  it('keeps the v2 and v3 purposes mutually unverifiable', async () => {
    const signed = await signReceipt(receiptFixture(outputFiles(1)));
    const publicKey = await ed25519.getPublicKeyAsync(receiptPrivateKey);
    await expect(
      verifyMaterializationReceiptV2({
        coseSign1: signed.coseSign1,
        expectedKeyId: receiptKeyId,
        publicKey,
      })
    ).rejects.toThrow('purpose does not match');
  });
});
