import * as ed25519 from '@noble/ed25519';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  computeOutputTreeRootV2,
  encodeDeliveryGrantV2,
  encodeMaterializationReceiptV2,
  PACKAGE_CONTRACT_PURPOSES,
  packageContractKeyId,
  signPackageContract,
} from '../../ops/storage-core/packageContractsV2';
import worker from './src/index';

const originalFetch = globalThis.fetch;
const installPrivateKey = new Uint8Array(32).fill(0x31);
const receiptPrivateKey = new Uint8Array(32).fill(0x41);
const installKeyId = packageContractKeyId('install-test-2026-01');
const receiptKeyId = packageContractKeyId('receipt-test-2026-01');
const jobId = 'job-protected-1';
const grantId = 'grant-protected-1';
const renditionBytes = new TextEncoder().encode('verified rendition zip bytes');
const renditionSha256 = createHash('sha256').update(renditionBytes).digest();

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function proofThumbprint(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: 'jwk' });
  return createHash('sha256')
    .update(
      JSON.stringify({
        crv: jwk.crv,
        kty: jwk.kty,
        x: jwk.x,
        y: jwk.y,
      })
    )
    .digest();
}

function createProof(input: {
  accessToken: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  url: string;
}): string {
  const header = encodeJson({
    alg: 'ES256',
    jwk: input.publicKey.export({ format: 'jwk' }),
    typ: 'dpop+jwt',
  });
  const payload = encodeJson({
    ath: createHash('sha256')
      .update(input.accessToken, 'ascii')
      .digest('base64url'),
    htm: 'POST',
    htu: input.url,
    iat: Math.floor(Date.now() / 1_000),
    jti: randomUUID(),
  });
  const signature = sign(
    'sha256',
    Buffer.from(`${header}.${payload}`, 'ascii'),
    { dsaEncoding: 'ieee-p1363', key: input.privateKey }
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function credentials(url: string) {
  const proofKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = Math.floor(Date.now() / 1_000);
  const releaseRoot = new Uint8Array(32).fill(0x11);
  const outputFile = {
    attributionId: 'attribution-1',
    normalizedPath: 'Assets/Jammr/a.png',
    outputBytes: 100,
    outputSha256: new Uint8Array(32).fill(0x66),
  };
  const grant = await signPackageContract({
    keyId: installKeyId,
    payload: encodeDeliveryGrantV2({
      audience: 'https://delivery.example.test',
      bindingRoot: new Uint8Array(32).fill(0x22),
      buyerId: 'buyer-1',
      creatorId: 'creator-1',
      deviceKeyThumbprint: proofThumbprint(proofKey.publicKey),
      expiresAt: now + 300,
      grantId,
      installSessionId: 'session-1',
      issuedAt: now,
      issuer: 'https://api.example.test',
      notBefore: now,
      productId: 'com.yucp.jammr',
      releaseRoot,
      scopes: [
        `materialization:${jobId}:read`,
        'package:version-jammr-123:read',
      ],
    }),
    privateKey: installPrivateKey,
    purpose: PACKAGE_CONTRACT_PURPOSES.deliveryGrant,
  });
  const receipt = await signPackageContract({
    keyId: receiptKeyId,
    payload: encodeMaterializationReceiptV2({
      buyerSubjectPseudonym: 'buyer-pseudonym-1',
      capabilityId: 'capability-1',
      codecBuild: 'codec-build-1',
      createdPaths: [outputFile.normalizedPath],
      creatorId: 'creator-1',
      expiresAt: now + 7 * 24 * 60 * 60,
      grantId,
      helperBuild: 'helper-build-1',
      issuedAt: now,
      jobId,
      keyEpoch: 1,
      leaseGeneration: 1,
      materializationAlgorithm: 'png-dct-qim-v2',
      materializerId: 'linux-data-node-1',
      outputFiles: [outputFile],
      outputTreeRoot: computeOutputTreeRootV2([outputFile]),
      pluginVersion: 'png-plugin-2',
      productId: 'com.yucp.jammr',
      protectedSourceRoot: new Uint8Array(32).fill(0x33),
      pseudonymMethod: 'hmac-sha256-hkdf-v2',
      receiptId: 'receipt-1',
      releaseRoot,
      rendition: {
        bucketName: 'renditions-test',
        fileIdentifier: 'file-version-1',
        objectBytes: renditionBytes.byteLength,
        objectKey: 'v2/renditions/aa/rendition.zip',
        objectSha256: renditionSha256,
        providerVersion: 'provider-version-1',
        storageRole: 'renditions',
      },
      runtimeBuild: 'runtime-build-1',
      traceId: 'trace-1',
    }),
    privateKey: receiptPrivateKey,
    purpose: PACKAGE_CONTRACT_PURPOSES.materializationReceipt,
  });
  const grantToken = Buffer.from(grant.coseSign1).toString('base64url');
  return {
    body: JSON.stringify({
      receipt: Buffer.from(receipt.coseSign1).toString('base64url'),
    }),
    headers: {
      Authorization: `DPoP ${grantToken}`,
      'Content-Type': 'application/json',
      DPoP: createProof({
        accessToken: grantToken,
        privateKey: proofKey.privateKey,
        publicKey: proofKey.publicKey,
        url,
      }),
    },
  };
}

async function testEnv() {
  return {
    PACKAGE_DELIVERY_AUDIENCE: 'https://delivery.example.test',
    PACKAGE_INSTALL_ISSUER: 'https://api.example.test',
    PACKAGE_INSTALL_SIGNING_KEY_ID: 'install-test-2026-01',
    PACKAGE_INSTALL_SIGNING_PUBLIC_KEY: Buffer.from(
      await ed25519.getPublicKeyAsync(installPrivateKey)
    ).toString('base64url'),
    RENDITION_RECEIPT_KEY_ID: 'receipt-test-2026-01',
    RENDITION_RECEIPT_PUBLIC_KEY: Buffer.from(
      await ed25519.getPublicKeyAsync(receiptPrivateKey)
    ).toString('base64url'),
    RENDITION_S3_BUCKET: 'renditions-test',
    RENDITION_S3_ENDPOINT: 'http://127.0.0.1:9000',
    RENDITION_S3_READONLY_ACCESS_KEY_ID: 'rendition-test-access',
    RENDITION_S3_READONLY_SECRET_ACCESS_KEY: 'rendition-test-secret',
    RENDITION_S3_REGION: 'us-east-1',
  };
}

describe('personalized rendition Worker', () => {
  it('rejects an unauthorized request before any rendition storage read', async () => {
    let storageReads = 0;
    globalThis.fetch = mock(async () => {
      storageReads += 1;
      throw new Error('must not read storage');
    }) as unknown as typeof fetch;
    const response = await worker.fetch(
      new Request(`https://delivery.example.test/v2/renditions/${jobId}`, {
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
      await testEnv()
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('x-rendition-storage-fetches')).toBe('0');
    expect(storageReads).toBe(0);
  });

  it('streams only the exact receipt-bound rendition version', async () => {
    const url = `https://delivery.example.test/v2/renditions/${jobId}`;
    let storageReads = 0;
    let storageUrl = '';
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      storageReads += 1;
      storageUrl = input instanceof Request ? input.url : String(input);
      return new Response(renditionBytes, {
        headers: {
          'Content-Length': String(renditionBytes.byteLength),
          'Content-Type': 'application/zip',
          'x-amz-meta-yucp-sha256': renditionSha256.toString('hex'),
          'x-amz-version-id': 'provider-version-1',
        },
      });
    }) as unknown as typeof fetch;
    const authorized = await credentials(url);
    const response = await worker.fetch(
      new Request(url, { ...authorized, method: 'POST' }),
      await testEnv()
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-rendition-storage-fetches')).toBe('1');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(renditionBytes);
    expect(storageReads).toBe(1);
    const origin = new URL(storageUrl);
    expect(origin.pathname).toBe(
      '/renditions-test/v2/renditions/aa/rendition.zip'
    );
    expect(origin.searchParams.get('versionId')).toBe('provider-version-1');
  });
});
