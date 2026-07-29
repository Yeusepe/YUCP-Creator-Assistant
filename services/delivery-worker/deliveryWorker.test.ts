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
import { ACTIVE_PROTECTION_POLICY_ID } from '../../ops/storage-core/protectionPolicyId';
import {
  createLogicalReleasePublicationV4,
  createLogicalReleaseRootV4,
} from '../../ops/storage-core/releasePublication';
import worker from './src/index';

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const grantPrivateKey = new Uint8Array(32).fill(0x39);
const grantKeyId = packageContractKeyId('delivery-grant-test-2026-01');
type ProofKeyPair = { privateKey: KeyObject; publicKey: KeyObject };

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function tamperCompactJwsSignature(jws: string): string {
  const parts = jws.split('.');
  const signature = Buffer.from(parts[2] ?? '', 'base64url');
  signature[0] = (signature[0] ?? 0) ^ 1;
  return `${parts[0]}.${parts[1]}.${signature.toString('base64url')}`;
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
  jti?: string;
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
    jti: input.jti ?? randomUUID(),
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
    protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
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
  proofJti?: string;
  proofKey?: ProofKeyPair;
  productId: string;
  releaseRoot: string;
  url: string;
  versionId: string;
}) {
  const proofKey = input.proofKey ?? generateKeyPairSync('ec', { namedCurve: 'P-256' });
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
      jti: input.proofJti,
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
    expect(storageRoles).toEqual(['metadata', 'common']);
    expect(chunkResponse.headers.get('x-delivery-storage-fetches')).toBe('1');
    expect(manifestResponse.headers.get('x-yucp-manifest-source')).toBe('storage');
    expect(chunkResponse.headers.get('x-yucp-manifest-source')).toBe('cache');
  });

  it('names the denial stage for membership and authorization rejections', async () => {
    const versionId = randomUUID();
    const chunkBytes = new TextEncoder().encode('denial stage release');
    const fixture = commonManifest(versionId, chunkBytes);
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const origin = new URL(new Request(input).url);
      if (origin.pathname.startsWith('/metadata-test/')) {
        return new Response(fixture.body, {
          headers: { 'Content-Length': String(Buffer.byteLength(fixture.body)) },
        });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const unauthorized = await worker.fetch(
      new Request(`https://delivery.example.test/v2/delivery/${versionId}/manifest`),
      await testEnv()
    );
    expect(unauthorized.status).toBe(403);
    expect(unauthorized.headers.get('x-yucp-denial-stage')).toBe('authorization');

    const missingChunkUrl = `https://delivery.example.test/v2/delivery/${versionId}/chunks/${'f'.repeat(64)}`;
    const membership = await worker.fetch(
      new Request(missingChunkUrl, {
        headers: await createAuthorization({
          bindingRoot: fixture.bindingRoot,
          productId: fixture.manifest.packageId,
          releaseRoot: fixture.manifest.releaseRoot,
          url: missingChunkUrl,
          versionId,
        }),
      }),
      await testEnv()
    );
    expect(membership.status).toBe(403);
    expect(membership.headers.get('x-yucp-denial-stage')).toBe('membership');
  });

  it('shares one manifest storage load across concurrent cold requests', async () => {
    const versionId = randomUUID();
    const chunkBytes = new TextEncoder().encode('single-flight release');
    const fixture = commonManifest(versionId, chunkBytes);
    let manifestFetches = 0;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const origin = new URL(new Request(input).url);
      if (origin.pathname.startsWith('/metadata-test/')) {
        manifestFetches += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(fixture.body, {
          headers: { 'Content-Length': String(Buffer.byteLength(fixture.body)) },
        });
      }
      if (origin.pathname.startsWith('/common-test/')) {
        return new Response(chunkBytes);
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const chunkId = fixture.manifest.files[0]?.chunks[0]?.id as string;
    const chunkUrl = `https://delivery.example.test/v2/delivery/${versionId}/chunks/${chunkId}`;
    const request = async () =>
      worker.fetch(
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

    const [first, second] = await Promise.all([request(), request()]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(manifestFetches).toBe(1);
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

  it('rejects a replayed DPoP proof before a second storage read', async () => {
    const versionId = randomUUID();
    const chunkBytes = new TextEncoder().encode('replay-protected common chunk');
    const fixture = commonManifest(versionId, chunkBytes);
    let storageFetches = 0;
    globalThis.fetch = mock(async () => {
      storageFetches += 1;
      return new Response(fixture.body, {
        headers: { 'Content-Length': String(Buffer.byteLength(fixture.body)) },
      });
    }) as unknown as typeof fetch;
    const url = `https://delivery.example.test/v2/delivery/${versionId}/manifest`;
    const headers = await createAuthorization({
      bindingRoot: fixture.bindingRoot,
      productId: fixture.manifest.packageId,
      proofJti: 'replayed-worker-proof',
      releaseRoot: fixture.manifest.releaseRoot,
      url,
      versionId,
    });

    const first = await worker.fetch(new Request(url, { headers }), await testEnv());
    const replay = await worker.fetch(new Request(url, { headers }), await testEnv());

    expect(first.status).toBe(200);
    expect(replay.status).toBe(403);
    expect(replay.headers.get('x-delivery-storage-fetches')).toBe('0');
    expect(storageFetches).toBe(1);
  });

  it('does not collide proofs that share one identifier across different device keys', async () => {
    const versionId = randomUUID();
    const fixture = commonManifest(versionId, new TextEncoder().encode('distinct-device-keys'));
    let storageFetches = 0;
    globalThis.fetch = mock(async () => {
      storageFetches += 1;
      return new Response(fixture.body);
    }) as unknown as typeof fetch;
    const url = `https://delivery.example.test/v2/delivery/${versionId}/manifest`;
    const common = {
      bindingRoot: fixture.bindingRoot,
      productId: fixture.manifest.packageId,
      proofJti: 'shared-proof-identifier',
      releaseRoot: fixture.manifest.releaseRoot,
      url,
      versionId,
    };

    const first = await worker.fetch(
      new Request(url, { headers: await createAuthorization(common) }),
      await testEnv()
    );
    const second = await worker.fetch(
      new Request(url, { headers: await createAuthorization(common) }),
      await testEnv()
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(storageFetches).toBe(1);
  });

  it('accepts fresh proof identifiers from the same device key', async () => {
    const versionId = randomUUID();
    const fixture = commonManifest(versionId, new TextEncoder().encode('fresh-proof-identifiers'));
    const proofKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    let storageFetches = 0;
    globalThis.fetch = mock(async () => {
      storageFetches += 1;
      return new Response(fixture.body);
    }) as unknown as typeof fetch;
    const url = `https://delivery.example.test/v2/delivery/${versionId}/manifest`;
    const common = {
      bindingRoot: fixture.bindingRoot,
      productId: fixture.manifest.packageId,
      proofKey,
      releaseRoot: fixture.manifest.releaseRoot,
      url,
      versionId,
    };

    const first = await worker.fetch(
      new Request(url, {
        headers: await createAuthorization({ ...common, proofJti: 'fresh-proof-1' }),
      }),
      await testEnv()
    );
    const second = await worker.fetch(
      new Request(url, {
        headers: await createAuthorization({ ...common, proofJti: 'fresh-proof-2' }),
      }),
      await testEnv()
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(storageFetches).toBe(1);
  });

  it('does not let invalid proof or grant attempts poison the replay cache', async () => {
    const versionId = randomUUID();
    const fixture = commonManifest(versionId, new TextEncoder().encode('unpoisoned-replay-cache'));
    const proofKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    let storageFetches = 0;
    globalThis.fetch = mock(async () => {
      storageFetches += 1;
      return new Response(fixture.body);
    }) as unknown as typeof fetch;
    const url = `https://delivery.example.test/v2/delivery/${versionId}/manifest`;
    const validHeaders = await createAuthorization({
      bindingRoot: fixture.bindingRoot,
      productId: fixture.manifest.packageId,
      proofJti: 'cache-poison-proof',
      proofKey,
      releaseRoot: fixture.manifest.releaseRoot,
      url,
      versionId,
    });
    const invalidProof = tamperCompactJwsSignature(validHeaders.DPoP);
    const encodedGrant = validHeaders.Authorization.slice('DPoP '.length);
    const invalidGrantBytes = Buffer.from(encodedGrant, 'base64url');
    const invalidGrantLastIndex = invalidGrantBytes.length - 1;
    invalidGrantBytes[invalidGrantLastIndex] = (invalidGrantBytes[invalidGrantLastIndex] ?? 0) ^ 1;
    const invalidGrant = invalidGrantBytes.toString('base64url');
    const invalidGrantProof = createProof({
      accessToken: invalidGrant,
      jti: 'cache-poison-proof',
      privateKey: proofKey.privateKey,
      publicKey: proofKey.publicKey,
      url,
    });

    const invalidProofResponse = await worker.fetch(
      new Request(url, {
        headers: { Authorization: validHeaders.Authorization, DPoP: invalidProof },
      }),
      await testEnv()
    );
    const invalidGrantResponse = await worker.fetch(
      new Request(url, {
        headers: { Authorization: `DPoP ${invalidGrant}`, DPoP: invalidGrantProof },
      }),
      await testEnv()
    );
    const validResponse = await worker.fetch(
      new Request(url, { headers: validHeaders }),
      await testEnv()
    );

    expect(invalidProofResponse.status).toBe(403);
    expect(invalidGrantResponse.status).toBe(403);
    expect(validResponse.status).toBe(200);
    expect(storageFetches).toBe(1);
  });

  it('reloads a republished manifest when a valid grant disagrees with the cache', async () => {
    const versionId = randomUUID();
    const staleFixture = commonManifest(versionId, new TextEncoder().encode('stale release'));
    const freshChunkBytes = new TextEncoder().encode('fresh release');
    const freshFixture = commonManifest(versionId, freshChunkBytes);
    let servedManifestBody = staleFixture.body;
    let manifestFetches = 0;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const origin = new URL(new Request(input).url);
      if (origin.pathname.startsWith('/metadata-test/')) {
        manifestFetches += 1;
        return new Response(servedManifestBody, {
          headers: { 'Content-Length': String(Buffer.byteLength(servedManifestBody)) },
        });
      }
      if (origin.pathname.startsWith('/common-test/')) {
        return new Response(freshChunkBytes);
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const manifestUrl = `https://delivery.example.test/v2/delivery/${versionId}/manifest`;
    const staleResponse = await worker.fetch(
      new Request(manifestUrl, {
        headers: await createAuthorization({
          bindingRoot: staleFixture.bindingRoot,
          productId: staleFixture.manifest.packageId,
          releaseRoot: staleFixture.manifest.releaseRoot,
          url: manifestUrl,
          versionId,
        }),
      }),
      await testEnv()
    );
    expect(staleResponse.status).toBe(200);

    servedManifestBody = freshFixture.body;
    const chunkId = freshFixture.manifest.files[0]?.chunks[0]?.id as string;
    const chunkUrl = `https://delivery.example.test/v2/delivery/${versionId}/chunks/${chunkId}`;
    const chunkResponse = await worker.fetch(
      new Request(chunkUrl, {
        headers: await createAuthorization({
          bindingRoot: freshFixture.bindingRoot,
          productId: freshFixture.manifest.packageId,
          releaseRoot: freshFixture.manifest.releaseRoot,
          url: chunkUrl,
          versionId,
        }),
      }),
      await testEnv()
    );

    expect(chunkResponse.status).toBe(200);
    expect(new Uint8Array(await chunkResponse.arrayBuffer())).toEqual(freshChunkBytes);
    expect(manifestFetches).toBe(2);
  });

  it('retries a rate limited storage read before serving the manifest', async () => {
    const versionId = randomUUID();
    const fixture = commonManifest(versionId, new TextEncoder().encode('rate limited release'));
    let manifestFetches = 0;
    globalThis.fetch = mock(async () => {
      manifestFetches += 1;
      if (manifestFetches === 1) {
        return new Response('slow down', { headers: { 'retry-after': '0' }, status: 503 });
      }
      return new Response(fixture.body, {
        headers: { 'Content-Length': String(Buffer.byteLength(fixture.body)) },
      });
    }) as unknown as typeof fetch;
    const url = `https://delivery.example.test/v2/delivery/${versionId}/manifest`;

    const response = await worker.fetch(
      new Request(url, {
        headers: await createAuthorization({
          bindingRoot: fixture.bindingRoot,
          productId: fixture.manifest.packageId,
          releaseRoot: fixture.manifest.releaseRoot,
          url,
          versionId,
        }),
      }),
      await testEnv()
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(fixture.body);
    expect(manifestFetches).toBe(2);
  });
});
