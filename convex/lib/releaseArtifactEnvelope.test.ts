import { describe, expect, it } from 'bun:test';
import {
  decryptArtifactEnvelope,
  deriveEnvelopeKeyBytes,
  encryptArtifactEnvelope,
  sha256HexBytes,
} from './releaseArtifactEnvelope';

describe('releaseArtifactEnvelope', () => {
  it('round-trips encrypted artifact bytes', async () => {
    const plaintext = new TextEncoder().encode('signed-metadata');
    const key = await deriveEnvelopeKeyBytes('test-secret', 'artifact|stable|win-x64|1.0.0');
    const encrypted = await encryptArtifactEnvelope(plaintext, key);
    const decrypted = await decryptArtifactEnvelope(encrypted.ciphertext, key, encrypted.ivBase64);

    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
    expect(encrypted.plaintextSha256).toBe(await sha256HexBytes(plaintext));
    expect(encrypted.ciphertextSha256).not.toBe(encrypted.plaintextSha256);
  });
});
