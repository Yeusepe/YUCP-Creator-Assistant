import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const httpSource = readFileSync(resolve(__dirname, './http.ts'), 'utf8');
const couplingServiceArtifactSource = readFileSync(
  resolve(__dirname, './lib/couplingServiceRuntimeArtifacts.ts'),
  'utf8'
);
const yucpLicensesSource = readFileSync(resolve(__dirname, './yucpLicenses.ts'), 'utf8');

describe('coupling runtime HTTP contract', () => {
  it('returns the plaintext runtime hash and direct runtime URL in coupling job responses', () => {
    expect(httpSource).toContain('runtimeSha256: artifact.plaintextSha256');
    expect(httpSource).toContain('runtimeUrl: buildRuntimeArtifactDownloadUrl(artifact, runtimeToken)');
  });

  it('resolves active runtime metadata from the coupling service manifest endpoint', () => {
    expect(couplingServiceArtifactSource).toContain('v1/runtime-artifacts/manifest?artifactKey=');
    expect(couplingServiceArtifactSource).toContain('YUCP_COUPLING_SERVICE_BASE_URL');
    expect(couplingServiceArtifactSource).toContain('YUCP_COUPLING_SERVICE_SHARED_SECRET');
  });

  it('records runtime trace issuance against coupling-service manifest metadata', () => {
    expect(yucpLicensesSource).toContain("fetchRuntimeArtifactManifest('coupling-runtime')");
    expect(yucpLicensesSource).toContain('runtimeArtifactVersion: activeRuntimeArtifact.version');
    expect(yucpLicensesSource).toContain(
      'runtimePlaintextSha256: activeRuntimeArtifact.plaintextSha256'
    );
  });

  it('mints runtime package tokens and includes a direct runtime package URL', () => {
    expect(httpSource).toContain("path: '/v1/licenses/runtime-package-token'");
    expect(httpSource).toContain('runtimePackageToken');
    expect(httpSource).toContain(
      'runtimePackageUrl: buildRuntimeArtifactDownloadUrl(artifact, runtimePackageToken)'
    );
  });

  it('redirects legacy Convex download routes to the coupling service', () => {
    expect(httpSource).toContain("path: '/v1/licenses/runtime-package'");
    expect(httpSource).toContain("path: '/v1/licenses/coupling-runtime'");
    expect(httpSource).toContain("redirectToRuntimeArtifact(token, 'coupling-runtime-package')");
    expect(httpSource).toContain("redirectToRuntimeArtifact(token, 'coupling-runtime')");
  });

  it('treats the sealed grant itself as the public authorization for redeem and receipt', () => {
    expect(httpSource).toContain("path: '/v1/licenses/protected-materialization-redeem'");
    expect(httpSource).toContain("path: '/v1/licenses/protected-materialization-receipt'");
    expect(httpSource).not.toContain('Broker authorization is required');
  });
});
