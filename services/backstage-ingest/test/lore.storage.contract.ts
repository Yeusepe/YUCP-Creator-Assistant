import { describe, expect, test } from 'bun:test';
import { materializeBackstageReleaseArtifact } from '@yucp/shared/backstageReleaseMaterialization';
import { sha256Hex } from '@yucp/shared/crypto';
import {
  getBackstageBytesFromLore,
  LoreApiRequestError,
  loreRepositoryIdForCreator,
  mintLorePresignedUrl,
  putBackstageBytesToLore,
  requireLoreBackstageConfig,
} from '@yucp/shared/loreBackstageClient';
import { strToU8, unzipSync } from 'fflate';

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Lore storage realtest requires ${name}.`);
  }
  return value;
}

const LORE_API_BASE_URL = requireEnvironmentVariable('LORE_API_BASE_URL');
const LORE_PRESIGN_HMAC_KEY = requireEnvironmentVariable('LORE_PRESIGN_HMAC_KEY');
const LORE_REPO_NAMESPACE_SALT = requireEnvironmentVariable('LORE_REPO_NAMESPACE_SALT');
const accessClientId = process.env.LORE_ACCESS_CLIENT_ID?.trim() || 'unused';
const accessClientSecret = process.env.LORE_ACCESS_CLIENT_SECRET?.trim() || 'unused';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const config = requireLoreBackstageConfig({
  apiBaseUrl: LORE_API_BASE_URL,
  presignHmacKey: LORE_PRESIGN_HMAC_KEY,
  repoNamespaceSalt: LORE_REPO_NAMESPACE_SALT,
  accessClientId,
  accessClientSecret,
  timeoutMs: 20_000,
});
const repositoryId = loreRepositoryIdForCreator('lore-contract-suite', LORE_REPO_NAMESPACE_SALT);

function buildContractBytes(): Uint8Array {
  const bytes = new Uint8Array(4096);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = (index * 37 + 11) & 0xff;
  }
  bytes.set(strToU8('yucp-lore-storage-contract-v1'), 1024);
  return bytes;
}

function expectByteExact(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  expect(actual).toEqual(expected);
}

const bytes = buildContractBytes();

describe('Lore storage real-backend contract', () => {
  test('stores and reads back content-addressed bytes byte-exact', async () => {
    const put = await putBackstageBytesToLore({ config, repositoryId, bytes });

    expect(put.address).toMatch(/^[0-9a-f]{64}-[0-9a-f]{32}$/);
    expect(put.sha256).toBe(await sha256Hex(bytes));
    expect(put.byteSize).toBe(bytes.byteLength);

    const got = new Uint8Array(
      await getBackstageBytesFromLore({ config, repositoryId, address: put.address })
    );
    expectByteExact(got, bytes);

    process.stdout.write(`[lore-contract] byte-exact address=${put.address}\n`);
  });

  test('is content-addressed by hash prefix with a unique address per PUT', async () => {
    const contentHash = (address: string) => address.split('-')[0];
    const first = await putBackstageBytesToLore({ config, repositoryId, bytes });
    const identical = await putBackstageBytesToLore({ config, repositoryId, bytes });

    // Lore addresses are <content-hash>-<per-object unique id>; full-address idempotency must not be assumed.
    expect(contentHash(identical.address)).toBe(contentHash(first.address));
    expect(identical.address).not.toBe(first.address);

    const differentBytes = bytes.slice();
    differentBytes[0] ^= 0xff;
    const different = await putBackstageBytesToLore({
      config,
      repositoryId,
      bytes: differentBytes,
    });
    expect(contentHash(different.address)).not.toBe(contentHash(first.address));

    process.stdout.write(
      `[lore-contract] content-addressed address=${first.address} distinctAddress=${different.address}\n`
    );
  });

  test('redeems a client-minted presigned URL byte-exact', async () => {
    const put = await putBackstageBytesToLore({ config, repositoryId, bytes });
    const { url } = await mintLorePresignedUrl({
      config,
      repositoryId,
      address: put.address,
      contentType: 'application/octet-stream',
    });

    const res = await fetch(url);
    expect(res.status).toBe(200);
    const got = new Uint8Array(await res.arrayBuffer());
    expectByteExact(got, bytes);

    process.stdout.write(`[lore-contract] presigned address=${put.address}\n`);
  });

  test('round-trips a materialized importer shim through Lore', async () => {
    const shim = await materializeBackstageReleaseArtifact({
      deliveryName: 'com.yucp.lore-contract-1.0.0.zip',
      contentType: 'application/zip',
      packageId: 'com.yucp.lore-contract',
      version: '1.0.0',
      displayName: 'Lore Contract',
      managedPaths: ['Assets/Contract/Thing.cs', 'Assets/Contract/Thing.cs.meta'],
      metadata: {
        yucp: {
          kind: 'alias-v1',
          installStrategy: 'server-authorized',
          aliasId: 'lore-contract-alias',
          importerPackage: 'com.yucp.importer',
        },
      },
    });

    const stored = await putBackstageBytesToLore({
      config,
      repositoryId,
      bytes: shim.deliverable.bytes,
    });
    expect(stored.sha256).toBe(shim.deliverable.sha256);

    const retrieved = new Uint8Array(
      await getBackstageBytesFromLore({ config, repositoryId, address: stored.address })
    );
    expectByteExact(retrieved, shim.deliverable.bytes);

    const { url } = await mintLorePresignedUrl({
      config,
      repositoryId,
      address: stored.address,
      contentType: 'application/zip',
    });
    const presignedResponse = await fetch(url);
    expect(presignedResponse.status).toBe(200);
    const presignedBytes = new Uint8Array(await presignedResponse.arrayBuffer());
    expectByteExact(presignedBytes, shim.deliverable.bytes);

    const archive = unzipSync(retrieved);
    const packageJsonBytes = archive['package.json'];
    expect(packageJsonBytes).toBeDefined();
    if (!packageJsonBytes) {
      throw new Error('Materialized importer shim is missing package.json.');
    }
    const packageJson = JSON.parse(new TextDecoder().decode(packageJsonBytes)) as {
      yucp: {
        aliasId: string;
        installPlan: { managedPaths: string[]; operation: string };
      };
    };
    expect(packageJson.yucp.aliasId).toBe('lore-contract-alias');
    expect(packageJson.yucp.installPlan.operation).toBe('install');
    expect(packageJson.yucp.installPlan.managedPaths).toContain('Assets/Contract/Thing.cs');
    expect(packageJson.yucp.installPlan.managedPaths).toContain('Assets/Contract/Thing.cs.meta');

    process.stdout.write(`[lore-contract] importer-shim address=${stored.address}\n`);
  });

  test('rejects a presigned URL with no token', async () => {
    const authRepositoryId = loreRepositoryIdForCreator(
      'lore-contract-auth',
      LORE_REPO_NAMESPACE_SALT
    );
    const stored = await putBackstageBytesToLore({
      config,
      repositoryId: authRepositoryId,
      bytes,
    });
    const { url } = await mintLorePresignedUrl({
      config,
      repositoryId: authRepositoryId,
      address: stored.address,
    });
    const unsignedUrl = new URL(url);
    unsignedUrl.search = '';

    const response = await fetch(unsignedUrl);
    expect(response.status).toBe(400);
  });

  test('rejects a tampered presigned token', async () => {
    const authRepositoryId = loreRepositoryIdForCreator(
      'lore-contract-auth',
      LORE_REPO_NAMESPACE_SALT
    );
    const stored = await putBackstageBytesToLore({
      config,
      repositoryId: authRepositoryId,
      bytes,
    });
    const { url } = await mintLorePresignedUrl({
      config,
      repositoryId: authRepositoryId,
      address: stored.address,
    });
    const tamperedUrl = new URL(url);
    const token = tamperedUrl.searchParams.get('token');
    if (!token) {
      throw new Error('Minted Lore presigned URL is missing its token.');
    }
    const tamperIndex = token.search(/[0-9a-f]/i);
    if (tamperIndex < 0) {
      throw new Error('Minted Lore presigned token has no hexadecimal character to mutate.');
    }
    const replacement = token[tamperIndex]?.toLowerCase() === 'a' ? 'b' : 'a';
    const tamperedToken = token.slice(0, tamperIndex) + replacement + token.slice(tamperIndex + 1);
    tamperedUrl.searchParams.set('token', tamperedToken);

    const response = await fetch(tamperedUrl);
    expect(response.status).toBe(401);
  });

  test('rejects a presigned URL signed with the wrong key', async () => {
    const authRepositoryId = loreRepositoryIdForCreator(
      'lore-contract-auth',
      LORE_REPO_NAMESPACE_SALT
    );
    const stored = await putBackstageBytesToLore({
      config,
      repositoryId: authRepositoryId,
      bytes,
    });
    const wrongKeyConfig = requireLoreBackstageConfig({
      ...config,
      presignHmacKey: 'c'.repeat(64),
    });
    const { url } = await mintLorePresignedUrl({
      config: wrongKeyConfig,
      repositoryId: authRepositoryId,
      address: stored.address,
    });

    const response = await fetch(url);
    expect(response.status).toBe(401);
  });

  test('rejects a presigned URL whose address was swapped', async () => {
    const authRepositoryId = loreRepositoryIdForCreator(
      'lore-contract-auth',
      LORE_REPO_NAMESPACE_SALT
    );
    const secondBytes = bytes.slice();
    secondBytes[0] ^= 0xff;
    const first = await putBackstageBytesToLore({
      config,
      repositoryId: authRepositoryId,
      bytes,
    });
    const second = await putBackstageBytesToLore({
      config,
      repositoryId: authRepositoryId,
      bytes: secondBytes,
    });
    const { url } = await mintLorePresignedUrl({
      config,
      repositoryId: authRepositoryId,
      address: first.address,
    });
    const swappedUrl = new URL(url);
    swappedUrl.pathname = swappedUrl.pathname.replace(first.address, second.address);

    const response = await fetch(swappedUrl);
    expect(response.status).toBe(401);
  });

  test('rejects an expired presigned URL', async () => {
    const authRepositoryId = loreRepositoryIdForCreator(
      'lore-contract-auth',
      LORE_REPO_NAMESPACE_SALT
    );
    const stored = await putBackstageBytesToLore({
      config,
      repositoryId: authRepositoryId,
      bytes,
    });
    const { url } = await mintLorePresignedUrl({
      config,
      repositoryId: authRepositoryId,
      address: stored.address,
      ttlSeconds: 1,
    });

    await delay(2_100);
    const response = await fetch(url);
    expect(response.status).toBe(401);
  });

  test('rejects an empty-body PUT', async () => {
    let thrown: unknown;
    try {
      await putBackstageBytesToLore({
        config,
        repositoryId,
        bytes: new Uint8Array(0),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LoreApiRequestError);
    expect((thrown as LoreApiRequestError).status).toBe(400);
  });

  test('throws when reading a non-existent address', async () => {
    const absentAddress = `${'f'.repeat(64)}-${'f'.repeat(32)}`;
    let thrown: unknown;
    try {
      await getBackstageBytesFromLore({ config, repositoryId, address: absentAddress });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LoreApiRequestError);
    expect((thrown as LoreApiRequestError).status).toBe(404);
  });

  test('stores and reads back a large payload byte-exact', async () => {
    const largeBytes = new Uint8Array(8 * 1024 * 1024);
    for (let index = 0; index < largeBytes.byteLength; index += 1) {
      largeBytes[index] = (index * 29 + (index >>> 8) + 17) & 0xff;
    }

    const stored = await putBackstageBytesToLore({ config, repositoryId, bytes: largeBytes });
    const retrieved = new Uint8Array(
      await getBackstageBytesFromLore({ config, repositoryId, address: stored.address })
    );
    expectByteExact(retrieved, largeBytes);

    const { url } = await mintLorePresignedUrl({
      config,
      repositoryId,
      address: stored.address,
      contentType: 'application/octet-stream',
    });
    const presignedResponse = await fetch(url);
    expect(presignedResponse.status).toBe(200);
    const presignedBytes = new Uint8Array(await presignedResponse.arrayBuffer());
    expectByteExact(presignedBytes, largeBytes);
  });

  test('round-trips content spanning all 256 byte values byte-exact', async () => {
    const marker = strToU8('yucp-all-byte-values');
    const allByteValues = new Uint8Array(4096 + marker.byteLength);
    for (let index = 0; index < 4096; index += 1) {
      allByteValues[index] = index & 0xff;
    }
    allByteValues.set(marker, 4096);

    const stored = await putBackstageBytesToLore({
      config,
      repositoryId,
      bytes: allByteValues,
    });
    const retrieved = new Uint8Array(
      await getBackstageBytesFromLore({ config, repositoryId, address: stored.address })
    );
    expectByteExact(retrieved, allByteValues);
  });

  test('isolates content by repository', async () => {
    const repoA = loreRepositoryIdForCreator('tenant-isolation-a', LORE_REPO_NAMESPACE_SALT);
    const repoB = loreRepositoryIdForCreator('tenant-isolation-b', LORE_REPO_NAMESPACE_SALT);
    expect(repoA).not.toBe(repoB);

    const stored = await putBackstageBytesToLore({ config, repositoryId: repoA, bytes });
    const retrieved = new Uint8Array(
      await getBackstageBytesFromLore({ config, repositoryId: repoA, address: stored.address })
    );
    expectByteExact(retrieved, bytes);

    let thrown: unknown;
    try {
      await getBackstageBytesFromLore({
        config,
        repositoryId: repoB,
        address: stored.address,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LoreApiRequestError);
    expect((thrown as LoreApiRequestError).status).toBe(404);
  });

  test('round-trips a unitypackage importer shim through Lore', async () => {
    const managedPaths = [
      'Assets/LoreContract/UnityPackage.prefab',
      'Assets/LoreContract/UnityPackage.prefab.meta',
    ];
    const shim = await materializeBackstageReleaseArtifact({
      deliveryName: 'com.yucp.lore-contract-unitypackage-1.0.0.unitypackage',
      contentType: 'application/octet-stream',
      packageId: 'com.yucp.lore-contract-unitypackage',
      version: '1.0.0',
      displayName: 'Lore Contract Unitypackage',
      managedPaths,
      metadata: {
        yucp: {
          kind: 'alias-v1',
          installStrategy: 'server-authorized',
          aliasId: 'lore-contract-unitypackage-alias',
          importerPackage: 'com.yucp.importer',
        },
      },
    });

    const stored = await putBackstageBytesToLore({
      config,
      repositoryId,
      bytes: shim.deliverable.bytes,
    });
    expect(stored.sha256).toBe(shim.deliverable.sha256);

    const retrieved = new Uint8Array(
      await getBackstageBytesFromLore({ config, repositoryId, address: stored.address })
    );
    expectByteExact(retrieved, shim.deliverable.bytes);

    const { url } = await mintLorePresignedUrl({
      config,
      repositoryId,
      address: stored.address,
      contentType: shim.contentType,
    });
    const presignedResponse = await fetch(url);
    expect(presignedResponse.status).toBe(200);
    const presignedBytes = new Uint8Array(await presignedResponse.arrayBuffer());
    expectByteExact(presignedBytes, shim.deliverable.bytes);

    const archive = unzipSync(retrieved);
    const packageJsonBytes = archive['package.json'];
    expect(packageJsonBytes).toBeDefined();
    if (!packageJsonBytes) {
      throw new Error('Materialized unitypackage importer shim is missing package.json.');
    }
    const packageJson = JSON.parse(new TextDecoder().decode(packageJsonBytes)) as {
      yucp: { installPlan: { managedPaths: string[]; operation: string } };
    };
    expect(packageJson.yucp.installPlan.operation).toBe('install');
    expect(packageJson.yucp.installPlan.managedPaths).toContain(
      'Packages/com.yucp.lore-contract-unitypackage/package.json'
    );
    for (const managedPath of managedPaths) {
      expect(packageJson.yucp.installPlan.managedPaths).toContain(managedPath);
    }
  });
});
