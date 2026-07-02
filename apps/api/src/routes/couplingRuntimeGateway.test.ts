import { afterEach, describe, expect, it } from 'bun:test';
import { createCouplingRuntimeRoutes } from './couplingRuntimeGateway';

// Config with no coupling service wired: every coupling-job path should short-circuit BEFORE any
// Convex/service call, so these tests need no network. They pin the dispatch + validation + graceful
// skip behaviour (coupling must never fail the import when the private service is absent).
const routes = createCouplingRuntimeRoutes({
  convexUrl: 'https://example.convex.cloud',
  convexApiSecret: 'test-secret',
});

function couplingJobRequest(body: unknown): Request {
  return new Request('https://api.test/v1/licenses/coupling-job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  packageId: 'song.thing',
  projectId: 'a'.repeat(32),
  machineFingerprint: 'b'.repeat(32),
  licenseToken: 'header.payload.sig',
  assetPaths: ['Assets/Body.png'],
};

const originalFetch = globalThis.fetch;

function licenseTokenWithSubject(subject: string): string {
  return `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.sig`;
}

describe('coupling runtime gateway', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null for unrelated paths so the request falls through', async () => {
    const res = await routes.handleRequest(new Request('https://api.test/v1/licenses/verify'));
    expect(res).toBeNull();
  });

  it('skips (no_runtime, never fails) when the coupling service is unconfigured', async () => {
    const res = await routes.handleRequest(couplingJobRequest(validBody));
    expect(res?.status).toBe(200);
    const json = (await res?.json()) as { success: boolean; files: unknown[]; skipReason: string };
    expect(json.success).toBe(true);
    expect(json.files).toEqual([]);
    expect(json.skipReason).toBe('no_runtime');
  });

  it('skips (no_assets) when there are no candidate assets', async () => {
    const res = await routes.handleRequest(couplingJobRequest({ ...validBody, assetPaths: [] }));
    const json = (await res?.json()) as { skipReason: string };
    expect(json.skipReason).toBe('no_assets');
  });

  it('rejects a body missing required fields', async () => {
    const res = await routes.handleRequest(couplingJobRequest({ packageId: 'song.thing' }));
    expect(res?.status).toBe(400);
  });

  it('rejects invalid JSON', async () => {
    const res = await routes.handleRequest(
      new Request('https://api.test/v1/licenses/coupling-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ not json',
      })
    );
    expect(res?.status).toBe(400);
  });

  it('requires a token on the runtime download', async () => {
    const res = await routes.handleRequest(
      new Request('https://api.test/v1/licenses/coupling-runtime')
    );
    expect(res?.status).toBe(400);
  });

  it('reports the runtime unavailable when the service is unconfigured', async () => {
    const res = await routes.handleRequest(
      new Request('https://api.test/v1/licenses/coupling-runtime?token=abc')
    );
    expect(res?.status).toBe(503);
  });

  it('treats malformed runtime manifests as no_runtime before seed derivation', async () => {
    const configuredRoutes = createCouplingRuntimeRoutes({
      convexUrl: 'https://example.convex.cloud',
      convexApiSecret: 'test-secret',
      couplingServiceBaseUrl: 'https://coupling.internal',
      couplingServiceSharedSecret: 'test-secret',
    });
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      fetchedUrls.push(String(input));
      if (String(input).includes('/runtime-artifacts/manifest')) {
        return new Response(
          JSON.stringify({
            success: true,
            artifactKey: 'coupling-runtime',
            version: '2026.07.02.1',
            plaintextSha256: 'a'.repeat(64),
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ seeds: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const res = await configuredRoutes.handleRequest(
      couplingJobRequest({
        ...validBody,
        licenseToken: licenseTokenWithSubject('license-subject'),
      })
    );

    const json = (await res?.json()) as { skipReason: string };
    expect(json.skipReason).toBe('no_runtime');
    expect(fetchedUrls).toHaveLength(1);
  });
});
