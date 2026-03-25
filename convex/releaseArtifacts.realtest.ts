import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import { makeTestConvex } from './testHelpers';

describe('releaseArtifacts.getActiveArtifact', () => {
  it('returns an artifact shape that satisfies its validator', async () => {
    const t = makeTestConvex();
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' })
      );
    });

    await t.mutation(internal.releaseArtifacts.publishArtifact, {
      artifactKey: 'coupling-runtime',
      channel: 'stable',
      platform: 'win-x64',
      version: '1.0.0',
      metadataVersion: 1,
      storageId,
      contentType: 'application/octet-stream',
      deliveryName: 'yucp-coupling.dll',
      envelopeCipher: 'aes-256-gcm',
      envelopeIvBase64: 'ZmFrZS1pdi1iYXNlNjQ=',
      ciphertextSha256: 'a'.repeat(64),
      ciphertextSize: 3,
      plaintextSha256: 'b'.repeat(64),
      plaintextSize: 3,
    });

    const artifact = await t.query(internal.releaseArtifacts.getActiveArtifact, {
      artifactKey: 'coupling-runtime',
      channel: 'stable',
      platform: 'win-x64',
    });

    expect(artifact).toMatchObject({
      artifactKey: 'coupling-runtime',
      channel: 'stable',
      platform: 'win-x64',
      version: '1.0.0',
      deliveryName: 'yucp-coupling.dll',
    });
    expect(artifact).not.toHaveProperty('_id');
    expect(artifact).not.toHaveProperty('_creationTime');
  });
});
