import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash, generateKeyPairSync, type KeyObject, randomUUID, sign } from 'node:crypto';
import * as ed25519 from '@noble/ed25519';
import {
  createDeliveryManifest,
  DESYNC_STORAGE_FORMAT_VERSION,
  type DeliveryManifest,
} from '../../ops/storage-core/deliveryManifest';
import {
  encodeDeliveryGrantV2,
  PACKAGE_CONTRACT_PURPOSES,
  packageContractKeyId,
  signPackageContract,
} from '../../ops/storage-core/packageContractsV2';
import {
  createLogicalReleasePublicationV4,
  createLogicalReleaseRootV4,
} from '../../ops/storage-core/releasePublication';
import worker from './src/index';

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const grantPrivateKey = new Uint8Array(32).fill(0x39);
const grantKeyId = packageContractKeyId('delivery-grant-test-2026-01');

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
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
    ath: createHash('sha256').update(input.accessToken, 'ascii').digest('base64url'),
    htm: 'GET',
    htu: input.url,
    iat: Math.floor(Date.now() / 1_000),
    jti: randomUUID(),
  });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`, 'ascii'), {
    dsaEncoding: 'ieee-p1363',
    key: input.privateKey,
  }).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function commonManifest(
  versionId: string,
  chunkBytes: Uint8Array
): {
  bindingRoot: string;
  body: string;
  manifest: DeliveryManifest;
} {
  const chunkSha256 = createHash('sha256').update(chunkBytes).digest('hex');
  const files = [
    {
      bytes: chunkBytes.byteLength,
      chunks: [
        {
          id: chunkSha256,
          sha256: chunkSha256,
          size: chunkBytes.byteLength,
        },
      ],
      classification: 'common' as const,
      normalizedPath: 'Assets/package.asset',
      sha256: chunkSha256,
    },
  ];
  const identity = createLogicalReleaseRootV4({
    files,
    packageId: 'com.yucp.example',
    version: '1.0.0',
    versionId,
  });
  const manifest = createDeliveryManifest({
    activeContentDigest: '44'.repeat(32),
    activePolicyVersion: 'active-content-policy-v1',
    chunkAvgKib: 256,
    commonRoot: identity.commonRoot,
    files,
    normalizationPolicyVersion: 'package-normalization-policy-v2',
    packageId: 'com.yucp.example',
    protectedSourceRoot: identity.protectedSourceRoot,
    protectionPolicyDigest: '55'.repeat(32),
    protectionPolicyId: 'common-only-v1',
    releaseRoot: identity.releaseRoot,
    schemaVersion: 4,
    storageFormatVersion: DESYNC_STORAGE_FORMAT_VERSION,
    version: '1.0.0',
    versionId,
    vpmDependencies: {},
    vpmRepositories: {},
  });
  const body = JSON.stringify(manifest);
  const publication = createLogicalReleasePublicationV4({
    files,
    manifest: new TextEncoder().encode(body),
    packageId: manifest.packageId,
    version: manifest.version,
    versionId,
  });
  return { bindingRoot: publication.bindingRoot, body, manifest };
}

async function createAuthorization(input: {
  bindingRoot: string;
  productId: string;
  releaseRoot: string;
  url: string;
  versionId: string;
}) {
  const proofKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = Math.floor(Date.now() / 1_000);
  const signed = await signPackageContract({
    keyId: grantKeyId,
    payload: encodeDeliveryGrantV2({
      audience: 'https://delivery.example.test',
      bindingRoot: Uint8Array.from(Buffer.from(input.bindingRoot, 'hex')),
      buyerId: 'buyer-1',
      creatorId: 'creator-1',
      deviceKeyThumbprint: proofThumbprint(proofKey.publicKey),
      expiresAt: now + 300,
      grantId: randomUUID(),
      installSessionId: 'install-session-1',
      issuedAt: now,
      issuer: 'https://api.example.test',
      notBefore: now,
      productId: input.productId,
      releaseRoot: Uint8Array.from(Buffer.from(input.releaseRoot, 'hex')),
      scopes: [`package:${input.versionId}:read`],
    }),
    privateKey: grantPrivateKey,
    purpose: PACKAGE_CONTRACT_PURPOSES.deliveryGrant,
  });
  const grant = Buffer.from(signed.coseSign1).toString('base64url');
  return {
    Authorization: `DPoP ${grant}`,
    DPoP: createProof({
      accessToken: grant,
      privateKey: proofKey.privateKey,
      publicKey: proofKey.publicKey,
      url: input.url,
    }),
  };
}

async function testEnv() {
  return {
    COMMON_CHUNK_PREFIX: 'chunks/',
    COMMON_S3_BUCKET: 'common-test',
    COMMON_S3_ENDPOINT: 'http://127.0.0.1:9000',
    COMMON_S3_READONLY_ACCESS_KEY_ID: 'common-read-access',
    COMMON_S3_READONLY_SECRET_ACCESS_KEY: 'common-read-secret',
    COMMON_S3_REGION: 'us-east-1',
    METADATA_INDEX_PREFIX: 'indexes/',
    METADATA_S3_BUCKET: 'metadata-test',
    METADATA_S3_ENDPOINT: 'http://127.0.0.1:9000',
    METADATA_S3_READONLY_ACCESS_KEY_ID: 'metadata-read-access',
    METADATA_S3_READONLY_SECRET_ACCESS_KEY: 'metadata-read-secret',
    METADATA_S3_REGION: 'us-east-1',
    PACKAGE_DELIVERY_AUDIENCE: 'https://delivery.example.test',
    PACKAGE_INSTALL_ISSUER: 'https://api.example.test',
    PACKAGE_INSTALL_SIGNING_KEY_ID: 'delivery-grant-test-2026-01',
    PACKAGE_INSTALL_SIGNING_PUBLIC_KEY: Buffer.from(
      await ed25519.getPublicKeyAsync(grantPrivateKey)
    ).toString('base64url'),
    STORAGE_FORMAT_VERSION: DESYNC_STORAGE_FORMAT_VERSION,
  };
}

describe('common package delivery Worker', () => {
  it('rejects an unauthorized request before storage', async () => {
    const warnings: string[] = [];
    console.warn = mock((message: string) => {
      warnings.push(message);
    });
    let storageFetches = 0;
    globalThis.fetch = mock(async () => {
      storageFetches += 1;
      throw new Error('must not fetch');
    }) as unknown as typeof fetch;
    const versionId = randomUUID();
    const response = await worker.fetch(
      new Request(`https://delivery.example.test/v2/delivery/${versionId}/manifest`),
      await testEnv()
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('x-delivery-storage-fetches')).toBe('0');
    expect(storageFetches).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"event":"delivery.request.denied"');
    expect(warnings[0]).not.toContain('Authorization');
  });

  it('uses isolated metadata and common credentials for a verified release', async () => {
    const versionId = randomUUID();
    const chunkBytes = new TextEncoder().encode('verified common chunk');
    const fixture = commonManifest(versionId, chunkBytes);
    const storageRoles: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const request = new Request(input);
      const origin = new URL(request.url);
      if (origin.pathname.startsWith('/metadata-test/')) {
        storageRoles.push('metadata');
        expect(request.headers.get('authorization')).toContain('Credential=metadata-read-access/');
        return new Response(fixture.body, {
          headers: {
            'Content-Length': String(Buffer.byteLength(fixture.body)),
            'Content-Type': 'application/json',
          },
        });
      }
      if (origin.pathname.startsWith('/common-test/')) {
        storageRoles.push('common');
        expect(request.headers.get('authorization')).toContain('Credential=common-read-access/');
        return new Response(chunkBytes);
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const manifestUrl = `https://delivery.example.test/v2/delivery/${versionId}/manifest`;
    const manifestResponse = await worker.fetch(
      new Request(manifestUrl, {
        headers: await createAuthorization({
          bindingRoot: fixture.bindingRoot,
          productId: fixture.manifest.packageId,
          releaseRoot: fixture.manifest.releaseRoot,
          url: manifestUrl,
          versionId,
        }),
      }),
      await testEnv()
    );
    expect(manifestResponse.status).toBe(200);
    expect((await manifestResponse.json()) as unknown).toEqual(fixture.manifest);

    const chunkId = fixture.manifest.files[0]?.chunks[0]?.id as string;
    const chunkUrl = `https://delivery.example.test/v2/delivery/${versionId}/chunks/${chunkId}`;
    const chunkResponse = await worker.fetch(
      new Request(chunkUrl, {
        headers: await createAuthorization({
          bindingRoot: fixture.bindingRoot,
          productId: fixture.manifest.packageId,
          releaseRoot: fixture.manifest.releaseRoot,
          url: chunkUrl,
          versionId,
        }),
      }),
      await testEnv()
    );
    expect(chunkResponse.status).toBe(200);
    expect(new Uint8Array(await chunkResponse.arrayBuffer())).toEqual(chunkBytes);
    expect(storageRoles).toEqual(['metadata', 'metadata', 'common']);
  });

  it('rejects a grant for a different version before storage', async () => {
    let storageFetches = 0;
    globalThis.fetch = mock(async () => {
      storageFetches += 1;
      throw new Error('must not fetch');
    }) as unknown as typeof fetch;
    const requestedVersion = randomUUID();
    const grantedVersion = randomUUID();
    const url = `https://delivery.example.test/v2/delivery/${requestedVersion}/manifest`;
    const response = await worker.fetch(
      new Request(url, {
        headers: await createAuthorization({
          bindingRoot: '22'.repeat(32),
          productId: 'product-1',
          releaseRoot: '11'.repeat(32),
          url,
          versionId: grantedVersion,
        }),
      }),
      await testEnv()
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('x-delivery-storage-fetches')).toBe('0');
    expect(storageFetches).toBe(0);
  });
});
