import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, type KeyObject, randomUUID, sign } from 'node:crypto';
import { resolve } from 'node:path';
import * as ed25519 from '@noble/ed25519';
import { getPlatformProxy, type PlatformProxy } from 'wrangler';
import {
  createDeliveryManifest,
  DESYNC_STORAGE_FORMAT_VERSION,
  type DeliveryManifest,
  deliveryManifestObjectId,
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

const grantPrivateKey = new Uint8Array(32).fill(0x39);
const grantKeyId = 'delivery-grant-e2e-2026-01';
const issuer = 'https://api.example.test';
const audience = 'https://delivery.example.test';

type SeedableBucket = R2Bucket & {
  put(key: string, value: ArrayBuffer | Uint8Array | string): Promise<unknown>;
};
let proxy: PlatformProxy<Record<string, unknown>>;
let commonBucket: SeedableBucket;
let metadataBucket: SeedableBucket;

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

function buildManifest(
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
    packageId: 'com.yucp.delivery-e2e',
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
    packageId: 'com.yucp.delivery-e2e',
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

async function authorization(input: {
  bindingRoot: string;
  releaseRoot: string;
  url: string;
  versionId: string;
}): Promise<HeadersInit> {
  const proofKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = Math.floor(Date.now() / 1_000);
  const signed = await signPackageContract({
    keyId: packageContractKeyId(grantKeyId),
    payload: encodeDeliveryGrantV2({
      audience,
      bindingRoot: Uint8Array.from(Buffer.from(input.bindingRoot, 'hex')),
      buyerId: 'buyer-e2e',
      creatorId: 'creator-e2e',
      deviceKeyThumbprint: proofThumbprint(proofKey.publicKey),
      expiresAt: now + 300,
      grantId: randomUUID(),
      installSessionId: randomUUID(),
      issuedAt: now,
      issuer,
      notBefore: now,
      productId: 'com.yucp.delivery-e2e',
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

async function deliveryEnv() {
  return {
    COMMON_BUCKET: commonBucket,
    COMMON_CHUNK_PREFIX: 'chunks/',
    METADATA_BUCKET: metadataBucket,
    METADATA_INDEX_PREFIX: 'indexes/',
    PACKAGE_DELIVERY_AUDIENCE: audience,
    PACKAGE_INSTALL_ISSUER: issuer,
    PACKAGE_INSTALL_SIGNING_KEY_ID: grantKeyId,
    PACKAGE_INSTALL_SIGNING_PUBLIC_KEY: Buffer.from(
      await ed25519.getPublicKeyAsync(grantPrivateKey)
    ).toString('base64url'),
    STORAGE_FORMAT_VERSION: DESYNC_STORAGE_FORMAT_VERSION,
  };
}

beforeAll(async () => {
  proxy = await getPlatformProxy({
    configPath: resolve(import.meta.dir, 'wrangler.jsonc'),
    persist: false,
  });
  commonBucket = proxy.env.COMMON_BUCKET as SeedableBucket;
  metadataBucket = proxy.env.METADATA_BUCKET as SeedableBucket;
}, 300_000);

afterAll(async () => {
  await proxy?.dispose();
}, 300_000);

describe('common package delivery Worker against local R2 bindings', () => {
  test('reads metadata and common chunks from separate buckets', async () => {
    const versionId = randomUUID();
    const chunkBytes = new TextEncoder().encode('real R2 delivery chunk');
    const fixture = buildManifest(versionId, chunkBytes);
    await metadataBucket.put(`indexes/${deliveryManifestObjectId(versionId)}`, fixture.body);
    const chunkId = fixture.manifest.files[0]?.chunks[0]?.id as string;
    await commonBucket.put(`chunks/${chunkId.slice(0, 4)}/${chunkId}`, chunkBytes);

    const manifestUrl = `${audience}/v2/delivery/${versionId}/manifest`;
    const manifestResponse = await worker.fetch(
      new Request(manifestUrl, {
        headers: await authorization({
          bindingRoot: fixture.bindingRoot,
          releaseRoot: fixture.manifest.releaseRoot,
          url: manifestUrl,
          versionId,
        }),
      }),
      await deliveryEnv()
    );
    expect(manifestResponse.status).toBe(200);
    expect((await manifestResponse.json()) as unknown).toEqual(fixture.manifest);

    const chunkUrl = `${audience}/v2/delivery/${versionId}/chunks/${chunkId}`;
    const chunkResponse = await worker.fetch(
      new Request(chunkUrl, {
        headers: await authorization({
          bindingRoot: fixture.bindingRoot,
          releaseRoot: fixture.manifest.releaseRoot,
          url: chunkUrl,
          versionId,
        }),
      }),
      await deliveryEnv()
    );
    expect(chunkResponse.status).toBe(200);
    expect(new Uint8Array(await chunkResponse.arrayBuffer())).toEqual(chunkBytes);
  }, 120_000);

  test('returns 404 for a version that is missing from the metadata bucket', async () => {
    const versionId = randomUUID();
    const fixture = buildManifest(versionId, new TextEncoder().encode('unseeded release'));
    const url = `${audience}/v2/delivery/${versionId}/manifest`;
    const response = await worker.fetch(
      new Request(url, {
        headers: await authorization({
          bindingRoot: fixture.bindingRoot,
          releaseRoot: fixture.manifest.releaseRoot,
          url,
          versionId,
        }),
      }),
      await deliveryEnv()
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('x-delivery-storage-fetches')).toBe('1');
  }, 120_000);

  test('performs no storage request for an unauthorized caller', async () => {
    const versionId = randomUUID();
    const response = await worker.fetch(
      new Request(`${audience}/v2/delivery/${versionId}/manifest`),
      await deliveryEnv()
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('x-delivery-storage-fetches')).toBe('0');
  });
});
