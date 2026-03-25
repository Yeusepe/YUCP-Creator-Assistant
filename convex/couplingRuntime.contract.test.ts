import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const httpSource = readFileSync(resolve(__dirname, './http.ts'), 'utf8');
const couplingSource = readFileSync(resolve(__dirname, './couplingRuntime.ts'), 'utf8');
const couplingUploadSource = readFileSync(resolve(__dirname, './couplingRuntimeUpload.ts'), 'utf8');

describe('coupling runtime HTTP contract', () => {
  it('returns the plaintext runtime hash in coupling job responses', () => {
    expect(httpSource).toContain('runtimeSha256: artifact.plaintextSha256');
  });

  it('decrypts the stored runtime artifact before serving downloads', () => {
    expect(httpSource).toContain('decryptArtifactEnvelope(');
    expect(httpSource).toContain('base64ToBytes(claims.envelope_key_b64)');
    expect(httpSource).toContain('X-YUCP-Runtime-Plaintext-Sha256');
  });

  it('supports activating a manually uploaded storage object as the active runtime artifact', () => {
    expect(couplingSource).toContain('export const publishUploadedRuntime = internalAction(');
    expect(couplingSource).toContain('await ctx.storage.delete(args.storageId);');
  });

  it('mints a dedicated upload URL for runtime publishing instead of sending DLL bytes through convex run args', () => {
    expect(couplingUploadSource).toContain(
      'export const generateRuntimeUploadUrl = internalMutation('
    );
    expect(couplingUploadSource).toContain('ctx.storage.generateUploadUrl()');
  });
});
