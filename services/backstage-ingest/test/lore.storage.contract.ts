import { describe, expect, test } from 'bun:test';
import { materializeBackstageReleaseArtifact } from '@yucp/shared/backstageReleaseMaterialization';
import { sha256Hex } from '@yucp/shared/crypto';
import {
  getBackstageBytesFromLore,
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
});
