import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import type { TestServerHandle } from './helpers/testServer';

type StubServer = {
  stop(): void;
};

mock.module('../src/lib/couplingRuntimeArtifacts', () => ({
  fetchRuntimeArtifactManifest: async (
    baseUrl: string,
    sharedSecret: string,
    artifactKey: 'coupling-runtime' | 'coupling-runtime-package'
  ) => {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, '')}/v1/runtime-artifacts/manifest?artifactKey=${encodeURIComponent(artifactKey)}`,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${sharedSecret.trim()}`,
          'Cache-Control': 'no-store',
        },
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const errorMessage = (
        payload as { error?: { message?: string } } | null
      )?.error?.message?.trim();
      if (errorMessage === 'No route matches GET /v1/runtime-artifacts/manifest') {
        return {
          success: false as const,
          error: `YUCP_COUPLING_SERVICE_BASE_URL points at a non-coupling service: ${errorMessage}`,
        };
      }
      return {
        success: false as const,
        error:
          errorMessage || `Coupling service manifest request failed with status ${response.status}`,
      };
    }

    return payload;
  },
  buildRuntimeArtifactDownloadUrl: (manifest: { downloadUrl: string }, token: string) => {
    const url = new URL(manifest.downloadUrl);
    url.searchParams.set('token', token);
    return url.toString();
  },
}));

describe('API server, coupling runtime surface', () => {
  let healthyApiServer: TestServerHandle;
  let brokenApiServer: TestServerHandle;
  let healthyCouplingServer: StubServer;
  let missingRouteCouplingServer: StubServer;
  let healthyCouplingBaseUrl = '';
  let missingRouteCouplingBaseUrl = '';
  let healthyCouplingPort = 0;

  beforeAll(async () => {
    const healthyCoupling = Bun.serve({
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url);
        if (request.headers.get('authorization') !== 'Bearer test-coupling-secret') {
          return Response.json({ error: { message: 'unauthorized' } }, { status: 401 });
        }

        if (url.pathname === '/v1/runtime-artifacts/manifest') {
          return Response.json({
            success: true,
            artifactKey: 'coupling-runtime',
            channel: 'stable',
            platform: 'win-x64',
            version: '2026.04.09',
            metadataVersion: 1,
            deliveryName: 'yucp_coupling.dll',
            contentType: 'application/octet-stream',
            envelopeCipher: 'none',
            envelopeIvBase64: '',
            ciphertextSha256: 'c'.repeat(64),
            ciphertextSize: 42,
            plaintextSha256: 'a'.repeat(64),
            plaintextSize: 42,
            downloadUrl: `http://127.0.0.1:${healthyCouplingPort}/v1/licenses/coupling-runtime`,
          });
        }

        return Response.json(
          { error: { message: `No route matches ${request.method} ${url.pathname}` } },
          { status: 404 }
        );
      },
    });

    const missingRouteCoupling = Bun.serve({
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url);
        return Response.json(
          { error: { message: `No route matches ${request.method} ${url.pathname}` } },
          { status: 404 }
        );
      },
    });

    if (healthyCoupling.port == null || missingRouteCoupling.port == null) {
      throw new Error('Failed to start coupling stub servers on ephemeral ports');
    }
    healthyCouplingPort = healthyCoupling.port;
    healthyCouplingBaseUrl = `http://127.0.0.1:${healthyCoupling.port}`;
    missingRouteCouplingBaseUrl = `http://127.0.0.1:${missingRouteCoupling.port}`;
    healthyCouplingServer = { stop: () => healthyCoupling.stop(true) };
    missingRouteCouplingServer = { stop: () => missingRouteCoupling.stop(true) };

    const { startTestServer } = await import('./helpers/testServer');
    healthyApiServer = await startTestServer({
      port: 3112,
      baseUrl: 'http://localhost:3112',
      couplingServiceBaseUrl: healthyCouplingBaseUrl,
      couplingServiceSharedSecret: 'test-coupling-secret',
    });
    brokenApiServer = await startTestServer({
      port: 3113,
      baseUrl: 'http://localhost:3113',
      couplingServiceBaseUrl: missingRouteCouplingBaseUrl,
      couplingServiceSharedSecret: 'test-coupling-secret',
    });
  });

  afterAll(() => {
    healthyApiServer?.stop();
    brokenApiServer?.stop();
    healthyCouplingServer?.stop();
    missingRouteCouplingServer?.stop();
  });

  it('mounts the runtime manifest and download redirect routes on the Bun API server', async () => {
    const manifestResponse = await healthyApiServer.fetch(
      '/v1/runtime-artifacts/manifest?artifactKey=coupling-runtime'
    );
    expect(manifestResponse.status).toBe(200);
    await expect(manifestResponse.json()).resolves.toEqual({
      success: true,
      artifactKey: 'coupling-runtime',
      channel: 'stable',
      platform: 'win-x64',
      version: '2026.04.09',
      metadataVersion: 1,
      deliveryName: 'yucp_coupling.dll',
      contentType: 'application/octet-stream',
      envelopeCipher: 'none',
      envelopeIvBase64: '',
      ciphertextSha256: 'c'.repeat(64),
      ciphertextSize: 42,
      plaintextSha256: 'a'.repeat(64),
      plaintextSize: 42,
      downloadUrl: `${healthyApiServer.url}/v1/licenses/coupling-runtime`,
    });

    const redirectResponse = await healthyApiServer.fetch(
      '/v1/licenses/coupling-runtime?token=runtime-token',
      {
        redirect: 'manual',
      }
    );
    expect(redirectResponse.status).toBe(307);
    expect(redirectResponse.headers.get('location')).toBe(
      `${healthyCouplingBaseUrl}/v1/licenses/coupling-runtime?token=runtime-token`
    );
  });

  it('reproduces the exact manifest error end-to-end when the coupling base URL points at a non-coupling service', async () => {
    const manifestResponse = await brokenApiServer.fetch(
      '/v1/runtime-artifacts/manifest?artifactKey=coupling-runtime'
    );
    expect(manifestResponse.status).toBe(503);
    await expect(manifestResponse.json()).resolves.toEqual({
      error:
        'YUCP_COUPLING_SERVICE_BASE_URL points at a non-coupling service: No route matches GET /v1/runtime-artifacts/manifest',
    });
  });

  it('fails fast when the coupling base URL is configured to the public API origin', async () => {
    const { startTestServer } = await import('./helpers/testServer');

    await expect(
      startTestServer({
        port: 3114,
        baseUrl: 'http://localhost:3114',
        couplingServiceBaseUrl: 'http://localhost:3114',
        couplingServiceSharedSecret: 'test-coupling-secret',
      })
    ).rejects.toThrow(
      'YUCP_COUPLING_SERVICE_BASE_URL must point at the private coupling service, not the public API origin'
    );
  });
});
