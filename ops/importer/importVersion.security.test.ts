import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signDeliveryUrl } from '../storage-core/deliverySigning';
import { localCasStore, storeArtifactToStore } from '../storage-core/desyncCas';
import { importerCapabilityBinding, importVersion } from './importVersion';

const TRUSTED_HMAC_KEY = 'trusted-importer-test-key';

let scratchPath = '';

beforeEach(async () => {
  scratchPath = await mkdtemp(join(tmpdir(), 'yucp-importer-security-'));
});

afterEach(async () => {
  await rm(scratchPath, { force: true, recursive: true });
});

async function storedArtifact(name: string, bytes: Uint8Array) {
  const artifactPath = join(scratchPath, `${name}.bin`);
  const indexId = join(scratchPath, `${name}.caibx`);
  const store = localCasStore(join(scratchPath, 'store'));
  await writeFile(artifactPath, bytes);
  await storeArtifactToStore({ artifactPath, indexId, store });
  return {
    artifactPath,
    expectedSha256: createHash('sha256').update(bytes).digest('hex'),
    indexId,
    store,
  };
}

describe('importer capability and destination safety', () => {
  test('rejects a version capability whose index and hash are swapped before writing bytes', async () => {
    const versionA = await storedArtifact('version-a', Buffer.from('version-a-content'));
    const versionB = await storedArtifact('version-b', Buffer.from('version-b-secret-content'));
    const versionId = 'version-a';
    const signed = await signDeliveryUrl({
      binding: importerCapabilityBinding(versionA.indexId, versionA.expectedSha256),
      expiresAt: Date.now() + 60_000,
      key: TRUSTED_HMAC_KEY,
      versionId,
    });
    const outputPath = join(scratchPath, 'existing-output.bin');
    const originalBytes = Buffer.from('existing-output-must-survive');
    await writeFile(outputPath, originalBytes);

    let failure: unknown;
    try {
      await importVersion(
        {
          capability: { ...signed, versionId },
          expectedSha256: versionB.expectedSha256,
          indexId: versionB.indexId,
          outputPath,
          store: versionA.store,
        },
        { hmacKey: TRUSTED_HMAC_KEY }
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Invalid or expired importer capability');
    expect(await readFile(outputPath)).toEqual(originalBytes);
  });

  test('rejects a capability signed with an attacker-selected key', async () => {
    const artifact = await storedArtifact('self-signed', Buffer.from('protected-content'));
    const versionId = 'protected-version';
    const attackerKey = 'attacker-selected-key';
    const signed = await signDeliveryUrl({
      binding: importerCapabilityBinding(artifact.indexId, artifact.expectedSha256),
      expiresAt: Date.now() + 60_000,
      key: attackerKey,
      versionId,
    });

    await expect(
      importVersion(
        {
          capability: { ...signed, versionId },
          expectedSha256: artifact.expectedSha256,
          indexId: artifact.indexId,
          outputPath: join(scratchPath, 'self-signed-output.bin'),
          store: artifact.store,
        },
        { hmacKey: TRUSTED_HMAC_KEY }
      )
    ).rejects.toThrow('Invalid or expired importer capability');
  });

  test('does not delete an existing output that is also the seed artifact', async () => {
    const artifactBytes = Buffer.from('seed-content-must-survive');
    const artifact = await storedArtifact('seed-alias', artifactBytes);
    const outputPath = join(scratchPath, 'seed-and-output.bin');
    await writeFile(outputPath, artifactBytes);
    const versionId = 'seed-alias-version';
    const signed = await signDeliveryUrl({
      binding: importerCapabilityBinding(artifact.indexId, artifact.expectedSha256),
      expiresAt: Date.now() + 60_000,
      key: TRUSTED_HMAC_KEY,
      versionId,
    });

    await expect(
      importVersion(
        {
          capability: { ...signed, versionId },
          expectedSha256: artifact.expectedSha256,
          indexId: artifact.indexId,
          outputPath,
          seed: { artifactPath: outputPath, indexId: artifact.indexId },
          store: artifact.store,
        },
        { hmacKey: TRUSTED_HMAC_KEY }
      )
    ).rejects.toThrow('Importer seed artifact must differ from output path');
    expect(await readFile(outputPath)).toEqual(artifactBytes);
  });
});
