import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const httpSource = readFileSync(resolve(__dirname, './http.ts'), 'utf8');
const couplingSource = readFileSync(resolve(__dirname, './couplingRuntime.ts'), 'utf8');
const couplingUploadSource = readFileSync(resolve(__dirname, './couplingRuntimeUpload.ts'), 'utf8');
const runtimeConfigSource = readFileSync(
  resolve(__dirname, './lib/couplingRuntimeConfig.ts'),
  'utf8'
);
const runtimeComBuildSource = readFileSync(
  resolve(__dirname, '../Verify/Native/coupling-runtime-com/build.ps1'),
  'utf8'
);
const runtimeHelperDefSource = readFileSync(
  resolve(__dirname, '../Verify/Native/yucp_coupling/yucp_coupling.runtime-helper.def'),
  'utf8'
);

describe('coupling runtime HTTP contract', () => {
  it('returns the plaintext runtime hash in coupling job responses', () => {
    expect(httpSource).toContain('runtimeSha256: artifact.plaintextSha256');
  });

  it('decrypts the stored runtime artifact before serving downloads', () => {
    expect(httpSource).toContain('decryptArtifactEnvelope(');
    expect(httpSource).toContain('deriveCouplingRuntimeEnvelopeKeyBytes({');
    expect(httpSource).not.toContain('envelope_key_b64:');
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

  it('publishes a separate runtime package artifact and upload URL for clean-machine bootstrap', () => {
    expect(couplingSource).toContain('RELEASE_ARTIFACT_KEYS.couplingRuntimePackage');
    expect(couplingSource).toContain(
      'export const publishUploadedRuntimePackage = internalAction('
    );
    expect(couplingSource).toContain(
      'export const getActiveRuntimePackageManifestData = internalAction('
    );
    expect(couplingUploadSource).toContain(
      'export const generateRuntimePackageUploadUrl = internalMutation('
    );
  });

  it('mints and serves runtime package downloads through dedicated public routes', () => {
    expect(httpSource).toContain("path: '/v1/licenses/runtime-package-token'");
    expect(httpSource).toContain("path: '/v1/licenses/runtime-package'");
    expect(httpSource).toContain('runtimePackageToken');
    expect(httpSource).toContain('X-YUCP-Runtime-Package-Plaintext-Sha256');
  });

  it('publishes the runtime helper from a separate runtime-helper build output', () => {
    expect(runtimeConfigSource).toContain("'runtime-helper'");
    expect(runtimeComBuildSource).toContain('-ExportProfile "runtime-helper"');
  });

  it('keeps decode exports out of the shipped runtime helper definition', () => {
    expect(runtimeHelperDefSource).toContain('xg_0115');
    expect(runtimeHelperDefSource).toContain('xg_0120');
    expect(runtimeHelperDefSource).not.toContain('xg_0118');
    expect(runtimeHelperDefSource).not.toContain('xg_0119');
    expect(runtimeHelperDefSource).not.toContain('xg_0121');
  });

  it('treats the sealed grant itself as the public authorization for redeem and receipt', () => {
    expect(httpSource).toContain("path: '/v1/licenses/protected-materialization-redeem'");
    expect(httpSource).toContain("path: '/v1/licenses/protected-materialization-receipt'");
    expect(httpSource).not.toContain('Broker authorization is required');
  });
});
