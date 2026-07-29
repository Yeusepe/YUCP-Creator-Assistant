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
const originalConsoleError = console.error;
const grantPrivateKey = new Uint8Array(32).fill(0x29);
const grantKeyId = packageContractKeyId('source-grant-test-2026-01');

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
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

function protectedManifest(
  versionId: string,
  chunkBytes: Uint8Array
): {
  bindingRoot: string;
  body: string;
  manifest: DeliveryManifest;
} {
  const chunkSha256 = createHash('sha256').update(chunkBytes).digest('hex');
  const commonBytes = new TextEncoder().encode('verified common chunk');
  const commonSha256 = createHash('sha256').update(commonBytes).digest('hex');
  const files = [
    {
      bytes: commonBytes.byteLength,
      chunks: [
        {
          id: commonSha256,
          sha256: commonSha256,
          size: commonBytes.byteLength,
        },
      ],
      classification: 'common' as const,
      normalizedPath: 'Assets/common.txt',
      sha256: commonSha256,
    },
    {
      bytes: chunkBytes.byteLength,
      chunks: [
        {
          id: chunkSha256,
          sha256: chunkSha256,
          size: chunkBytes.byteLength,
        },
      ],
      classification: 'protected' as const,
      materializerType: 'png-dct-qim-v2',
      normalizedPath: 'Assets/package.png',
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
  releaseRoot: string;
  url: string;
  versionId: string;
}) {
  const proofKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = Math.floor(Date.now() / 1_000);
  const signed = await signPackageContract({
    keyId: grantKeyId,
    payload: encodeDeliveryGrantV2({
      audience: 'https://source.example.test',
      bindingRoot: Uint8Array.from(Buffer.from(input.bindingRoot, 'hex')),
      buyerId: 'linux-materializer-1',
      creatorId: 'creator-1',
      deviceKeyThumbprint: proofThumbprint(proofKey.publicKey),
      expiresAt: now + 300,
      grantId: randomUUID(),
      installSessionId: 'job-1',
      issuedAt: now,
      issuer: 'https://api.example.test',
      notBefore: now,
      productId: 'com.yucp.example',
      releaseRoot: Uint8Array.from(Buffer.from(input.releaseRoot, 'hex')),
      scopes: [`materialization-source:${input.versionId}`],
    }),
    privateKey: grantPrivateKey,
    purpose: PACKAGE_CONTRACT_PURPOSES.deliveryGrant,
  });
  const grant = Buffer.from(signed.coseSign1).toString('base64url');
  return {
    Authorization: `DPoP ${grant}`,
    DPoP: createProof({
      accessToken: grant,
      ...(input.proofJti ? { jti: input.proofJti } : {}),
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
    DELIVERY_GRANT_ISSUER: 'https://api.example.test',
    DELIVERY_GRANT_KEY_ID: 'source-grant-test-2026-01',
    DELIVERY_GRANT_PUBLIC_KEY: Buffer.from(
      await ed25519.getPublicKeyAsync(grantPrivateKey)
    ).toString('base64url'),
    MATERIALIZATION_SOURCE_AUDIENCE: 'https://source.example.test',
    METADATA_INDEX_PREFIX: 'indexes/',
    METADATA_S3_BUCKET: 'metadata-test',
    METADATA_S3_ENDPOINT: 'http://127.0.0.1:9000',
    METADATA_S3_READONLY_ACCESS_KEY_ID: 'metadata-read-access',
    METADATA_S3_READONLY_SECRET_ACCESS_KEY: 'metadata-read-secret',
    METADATA_S3_REGION: 'us-east-1',
    PROTECTED_CHUNK_PREFIX: 'chunks/',
    PROTECTED_S3_BUCKET: 'protected-test',
    PROTECTED_S3_ENDPOINT: 'http://127.0.0.1:9000',
    PROTECTED_S3_READONLY_ACCESS_KEY_ID: 'protected-read-access',
    PROTECTED_S3_READONLY_SECRET_ACCESS_KEY: 'protected-read-secret',
    PROTECTED_S3_REGION: 'us-east-1',
    STORAGE_FORMAT_VERSION: DESYNC_STORAGE_FORMAT_VERSION,
  };
}

describe('materialization source Worker', () => {
  it('rejects an unauthorized source request before any storage read', async () => {
    let storageFetches = 0;
    globalThis.fetch = mock(async () => {
      storageFetches += 1;
      throw new Error('must not fetch');
    }) as unknown as typeof fetch;
    const versionId = randomUUID();
    const response = await worker.fetch(
      new Request(
        `https://source.example.test/v2/internal/materialization-sources/${versionId}/manifest`
      ),
      await testEnv()
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('x-delivery-storage-fetches')).toBe('0');
    expect(storageFetches).toBe(0);
  });

  it('uses isolated metadata, common, and protected credentials for source members', async () => {
    const versionId = randomUUID();
    const chunkBytes = new TextEncoder().encode('verified protected chunk');
    const fixture = protectedManifest(versionId, chunkBytes);
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
        return new Response(new TextEncoder().encode('verified common chunk'));
      }
      if (origin.pathname.startsWith('/protected-test/')) {
        storageRoles.push('protected');
        expect(request.headers.get('authorization')).toContain('Credential=protected-read-access/');
        return new Response(chunkBytes);
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const manifestUrl = `https://source.example.test/v2/internal/materialization-sources/${versionId}/manifest`;
    const manifestResponse = await worker.fetch(
      new Request(manifestUrl, {
        headers: await createAuthorization({
          bindingRoot: fixture.bindingRoot,
          releaseRoot: fixture.manifest.releaseRoot,
          url: manifestUrl,
          versionId,
        }),
      }),
      await testEnv()
    );
    expect(manifestResponse.status).toBe(200);
    expect(await manifestResponse.text()).toBe(fixture.body);

    const commonChunkId = fixture.manifest.files.find((file) => file.classification === 'common')
      ?.chunks[0]?.id as string;
    const commonChunkUrl = `https://source.example.test/v2/internal/materialization-sources/${versionId}/chunks/${commonChunkId}`;
    const commonChunkResponse = await worker.fetch(
      new Request(commonChunkUrl, {
        headers: await createAuthorization({
          bindingRoot: fixture.bindingRoot,
          releaseRoot: fixture.manifest.releaseRoot,
          url: commonChunkUrl,
          versionId,
        }),
      }),
      await testEnv()
    );
    expect(commonChunkResponse.status).toBe(200);
    expect(new TextDecoder().decode(await commonChunkResponse.arrayBuffer())).toBe(
      'verified common chunk'
    );

    const protectedChunkId = fixture.manifest.files.find(
      (file) => file.classification === 'protected'
    )?.chunks[0]?.id as string;
    const protectedChunkUrl = `https://source.example.test/v2/internal/materialization-sources/${versionId}/chunks/${protectedChunkId}`;
    const chunkResponse = await worker.fetch(
      new Request(protectedChunkUrl, {
        headers: await createAuthorization({
          bindingRoot: fixture.bindingRoot,
          releaseRoot: fixture.manifest.releaseRoot,
          url: protectedChunkUrl,
          versionId,
        }),
      }),
      await testEnv()
    );
    expect(chunkResponse.status).toBe(200);
    expect(new Uint8Array(await chunkResponse.arrayBuffer())).toEqual(chunkBytes);
    expect(storageRoles).toEqual(['metadata', 'common', 'protected']);
  });

  it('logs a safe validation diagnostic without exposing the manifest body', async () => {
    const versionId = randomUUID();
    const chunkBytes = new TextEncoder().encode('invalid protected manifest');
    const fixture = protectedManifest(versionId, chunkBytes);
    const privateMarker = 'must-not-appear-in-worker-logs';
    const diagnostics: string[] = [];
    console.error = mock((message: string) => {
      diagnostics.push(message);
    });
    globalThis.fetch = mock(async () =>
      Response.json({
        privateMarker,
        schemaVersion: 4,
      })
    ) as unknown as typeof fetch;
    const url = `https://source.example.test/v2/internal/materialization-sources/${versionId}/manifest`;

    const response = await worker.fetch(
      new Request(url, {
        headers: await createAuthorization({
          bindingRoot: fixture.bindingRoot,
          releaseRoot: fixture.manifest.releaseRoot,
          url,
          versionId,
        }),
      }),
      await testEnv()
    );

    expect(response.status).toBe(502);
    expect(response.headers.get('x-delivery-storage-fetches')).toBe('1');
    expect(diagnostics).toHaveLength(1);
    expect(JSON.parse(diagnostics[0] ?? '')).toEqual({
      errorCode: 'MATERIALIZATION_SOURCE_MANIFEST_INVALID',
      event: 'materialization.source_manifest.validation_failed',
      jobId: 'job-1',
      reason: 'Delivery manifest has an invalid storageFormatVersion',
      versionId,
    });
    expect(diagnostics[0]).not.toContain(privateMarker);
  });

  it('logs safe manifest-membership facts when a requested chunk is absent', async () => {
    const versionId = randomUUID();
    const chunkBytes = new TextEncoder().encode('protected source chunk');
    const fixture = protectedManifest(versionId, chunkBytes);
    const diagnostics: string[] = [];
    console.error = mock((message: string) => {
      diagnostics.push(message);
    });
    globalThis.fetch = mock(async () => new Response(fixture.body)) as unknown as typeof fetch;
    const missingChunkId = 'f'.repeat(64);
    const url =
      `https://source.example.test/v2/internal/materialization-sources/${versionId}/chunks/` +
      missingChunkId;

    const response = await worker.fetch(
      new Request(url, {
        headers: await createAuthorization({
          bindingRoot: fixture.bindingRoot,
          releaseRoot: fixture.manifest.releaseRoot,
          url,
          versionId,
        }),
      }),
      await testEnv()
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('x-delivery-storage-fetches')).toBe('1');
    expect(diagnostics).toHaveLength(1);
    expect(JSON.parse(diagnostics[0] ?? '')).toEqual({
      chunkCount: 2,
      errorCode: 'MATERIALIZATION_SOURCE_CHUNK_NOT_IN_MANIFEST',
      event: 'materialization.source_chunk.not_in_manifest',
      fileCount: 2,
      jobId: 'job-1',
      requestedIdMatchesChunkSha256: false,
      requestedIdMatchesFileSha256: false,
      versionId,
    });
    expect(diagnostics[0]).not.toContain(missingChunkId);

    // The materializer classifies rejections by the x-yucp-denial-stage header,
    // so membership rejections must carry it even on manifest cache hits where
    // the storage-fetch count is legitimately zero.
    const cachedMissUrl =
      `https://source.example.test/v2/internal/materialization-sources/${versionId}/chunks/` +
      'e'.repeat(64);
    const cachedMissResponse = await worker.fetch(
      new Request(cachedMissUrl, {
        headers: await createAuthorization({
          bindingRoot: fixture.bindingRoot,
          releaseRoot: fixture.manifest.releaseRoot,
          url: cachedMissUrl,
          versionId,
        }),
      }),
      await testEnv()
    );
    expect(cachedMissResponse.status).toBe(403);
    expect(cachedMissResponse.headers.get('x-delivery-storage-fetches')).toBe('0');
    expect(cachedMissResponse.headers.get('x-yucp-denial-stage')).toBe('membership');
  });

  it('rejects a source grant for a different version before storage', async () => {
    let storageFetches = 0;
    globalThis.fetch = mock(async () => {
      storageFetches += 1;
      throw new Error('must not fetch');
    }) as unknown as typeof fetch;
    const requestedVersion = randomUUID();
    const grantedVersion = randomUUID();
    const url = `https://source.example.test/v2/internal/materialization-sources/${requestedVersion}/manifest`;
    const response = await worker.fetch(
      new Request(url, {
        headers: await createAuthorization({
          bindingRoot: '22'.repeat(32),
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

  it('rejects a replayed DPoP proof before a second source storage read', async () => {
    const versionId = randomUUID();
    const chunkBytes = new TextEncoder().encode('replay-protected chunk');
    const fixture = protectedManifest(versionId, chunkBytes);
    const url = `https://source.example.test/v2/internal/materialization-sources/${versionId}/manifest`;
    let storageFetches = 0;
    globalThis.fetch = mock(async () => {
      storageFetches += 1;
      return new Response(fixture.body, {
        headers: {
          'Content-Length': String(Buffer.byteLength(fixture.body)),
          'Content-Type': 'application/json',
        },
      });
    }) as unknown as typeof fetch;
    const headers = await createAuthorization({
      bindingRoot: fixture.bindingRoot,
      proofJti: 'replayed-materialization-source-proof',
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
});
