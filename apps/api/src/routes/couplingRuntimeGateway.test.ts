import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const convexActionRefs = {
  assembleCouplingJob: 'assembleCouplingJob',
  verifyCouplingJobLicense: 'verifyCouplingJobLicense',
};

let convexActionImpl: (reference: unknown, args: unknown) => Promise<unknown> = async (
  reference
) => {
  if (reference === convexActionRefs.verifyCouplingJobLicense) {
    return { success: true, licenseSubject: 'license-subject' };
  }
  if (reference === convexActionRefs.assembleCouplingJob) {
    return { success: true, files: [], skipReason: 'seed_unavailable' };
  }
  throw new Error('Unexpected Convex action');
};

const convexActionMock = mock((reference: unknown, args: unknown) =>
  convexActionImpl(reference, args)
);

mock.module('../../../../convex/_generated/api', () => ({
  api: {
    yucpLicenses: convexActionRefs,
  },
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    action: convexActionMock,
  }),
}));

import {
  COUPLING_JOB_BODY_MAX_BYTES,
  createCouplingRuntimeRoutes,
  MAX_COUPLING_ASSET_PATHS,
  RUNTIME_DOWNLOAD_MAX_BYTES,
} from './couplingRuntimeGateway';

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
  licenseToken: 'test-license-token',
  assetPaths: ['Assets/Body.png'],
};

const configuredRouteOptions = {
  convexUrl: 'https://example.convex.cloud',
  convexApiSecret: 'test-secret',
  couplingServiceBaseUrl: 'https://coupling.internal',
  couplingServiceSharedSecret: 'test-secret',
};

const originalFetch = globalThis.fetch;

function licenseTokenWithSubject(subject: string): string {
  return `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.sig`;
}

function oversizedRuntimeBody(): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024);
  let bytesSent = 0;

  return new ReadableStream({
    pull(controller) {
      if (bytesSent > RUNTIME_DOWNLOAD_MAX_BYTES) {
        controller.close();
        return;
      }
      bytesSent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

async function readStreamFailure(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
  if (!body) return new Error('missing response body');
  const reader = body.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) return null;
    }
  } catch (error) {
    return error;
  }
}

describe('coupling runtime gateway', () => {
  beforeEach(() => {
    convexActionImpl = async (reference) => {
      if (reference === convexActionRefs.verifyCouplingJobLicense) {
        return { success: true, licenseSubject: 'license-subject' };
      }
      if (reference === convexActionRefs.assembleCouplingJob) {
        return { success: true, files: [], skipReason: 'seed_unavailable' };
      }
      throw new Error('Unexpected Convex action');
    };
    convexActionMock.mockClear();
  });

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

  it('rejects oversized coupling-job bodies before parsing', async () => {
    const res = await routes.handleRequest(
      new Request('https://api.test/v1/licenses/coupling-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, padding: 'x'.repeat(COUPLING_JOB_BODY_MAX_BYTES) }),
      })
    );
    expect(res?.status).toBe(413);
  });

  it('rejects too many coupling asset paths', async () => {
    const res = await routes.handleRequest(
      couplingJobRequest({
        ...validBody,
        assetPaths: Array.from(
          { length: MAX_COUPLING_ASSET_PATHS + 1 },
          (_, index) => `Assets/${index}.png`
        ),
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

  it('returns 405 for known coupling paths with unsupported methods', async () => {
    const jobRes = await routes.handleRequest(
      new Request('https://api.test/v1/licenses/coupling-job', { method: 'GET' })
    );
    const runtimeRes = await routes.handleRequest(
      new Request('https://api.test/v1/licenses/coupling-runtime', { method: 'POST' })
    );
    expect(jobRes?.status).toBe(405);
    expect(runtimeRes?.status).toBe(405);
  });

  it('rejects unverifiable licenses before calling the coupling service', async () => {
    const configuredRoutes = createCouplingRuntimeRoutes(configuredRouteOptions);
    let couplingServiceCalled = false;
    globalThis.fetch = (async () => {
      couplingServiceCalled = true;
      return new Response(JSON.stringify({ seeds: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    convexActionImpl = async (reference) => {
      expect(reference).toBe(convexActionRefs.verifyCouplingJobLicense);
      return { success: false, error: 'License token is invalid or expired' };
    };

    const res = await configuredRoutes.handleRequest(
      couplingJobRequest({
        ...validBody,
        licenseToken: licenseTokenWithSubject('attacker-subject'),
      })
    );

    expect(res?.status).toBe(422);
    const json = (await res?.json()) as { error: string };
    expect(json.error).toBe('License token is invalid or expired');
    expect(couplingServiceCalled).toBe(false);
    expect(convexActionMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed asset paths before calling the coupling service', async () => {
    const configuredRoutes = createCouplingRuntimeRoutes(configuredRouteOptions);
    let couplingServiceCalled = false;
    globalThis.fetch = (async () => {
      couplingServiceCalled = true;
      return new Response(null);
    }) as unknown as typeof fetch;

    const res = await configuredRoutes.handleRequest(
      couplingJobRequest({
        ...validBody,
        assetPaths: [''],
      })
    );

    expect(res?.status).toBe(400);
    const json = (await res?.json()) as { error: string };
    expect(json.error).toBe('Invalid coupling asset path');
    expect(couplingServiceCalled).toBe(false);
    expect(convexActionMock).toHaveBeenCalledTimes(0);
  });

  it('rejects malformed project ids before Convex or coupling-service calls', async () => {
    const configuredRoutes = createCouplingRuntimeRoutes(configuredRouteOptions);
    let couplingServiceCalled = false;
    globalThis.fetch = (async () => {
      couplingServiceCalled = true;
      return new Response(null);
    }) as unknown as typeof fetch;

    const res = await configuredRoutes.handleRequest(
      couplingJobRequest({
        ...validBody,
        projectId: 'not-a-project-id',
      })
    );

    expect(res?.status).toBe(400);
    const json = (await res?.json()) as { error: string };
    expect(json.error).toBe('Invalid projectId format');
    expect(couplingServiceCalled).toBe(false);
    expect(convexActionMock).toHaveBeenCalledTimes(0);
  });

  it('treats malformed runtime manifests as no_runtime before seed derivation', async () => {
    const configuredRoutes = createCouplingRuntimeRoutes(configuredRouteOptions);
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
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
    }) as unknown as typeof fetch;

    const res = await configuredRoutes.handleRequest(
      couplingJobRequest({
        ...validBody,
        licenseToken: licenseTokenWithSubject('license-subject'),
      })
    );

    const json = (await res?.json()) as { skipReason: string };
    expect(json.skipReason).toBe('no_runtime');
    expect(fetchedUrls).toHaveLength(1);
    expect(convexActionMock).toHaveBeenCalledTimes(1);
  });

  it('accepts the private service none-envelope manifest with an empty IV', async () => {
    const configuredRoutes = createCouplingRuntimeRoutes(configuredRouteOptions);
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      fetchedUrls.push(String(input));
      if (String(input).includes('/runtime-artifacts/manifest')) {
        return new Response(
          JSON.stringify({
            success: true,
            artifactKey: 'coupling-runtime',
            channel: 'stable',
            platform: 'win-x64',
            version: '2026.07.02.1',
            metadataVersion: 1,
            deliveryName: 'yucp_coupling.dll',
            contentType: 'application/octet-stream',
            envelopeCipher: 'none',
            envelopeIvBase64: '',
            ciphertextSha256: 'a'.repeat(64),
            ciphertextSize: 1024,
            plaintextSha256: 'a'.repeat(64),
            plaintextSize: 1024,
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ seeds: [{ assetPath: 'Assets/Body.png', seedHex: 'b'.repeat(64) }] }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const res = await configuredRoutes.handleRequest(
      couplingJobRequest({
        ...validBody,
        licenseToken: licenseTokenWithSubject('license-subject'),
      })
    );

    expect(res?.status).toBe(200);
    expect(fetchedUrls).toHaveLength(2);
    expect(convexActionMock).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized runtime downloads before proxying the body', async () => {
    const configuredRoutes = createCouplingRuntimeRoutes(configuredRouteOptions);
    globalThis.fetch = (async () =>
      new Response('too large', {
        headers: {
          'Content-Length': String(RUNTIME_DOWNLOAD_MAX_BYTES + 1),
          'Content-Type': 'application/octet-stream',
        },
      })) as unknown as typeof fetch;

    const res = await configuredRoutes.handleRequest(
      new Request('https://api.test/v1/licenses/coupling-runtime?token=abc')
    );

    expect(res?.status).toBe(502);
  });

  it('aborts runtime downloads when the stream exceeds the size limit', async () => {
    const configuredRoutes = createCouplingRuntimeRoutes(configuredRouteOptions);
    globalThis.fetch = (async () =>
      new Response(oversizedRuntimeBody(), {
        headers: {
          'Content-Length': '1',
          'Content-Type': 'application/octet-stream',
        },
      })) as unknown as typeof fetch;

    const res = await configuredRoutes.handleRequest(
      new Request('https://api.test/v1/licenses/coupling-runtime?token=abc')
    );

    expect(res?.status).toBe(200);
    const error = await readStreamFailure(res?.body ?? null);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Coupling runtime download exceeded size limit');
  });

  it('does not proxy private-service runtime error bodies to callers', async () => {
    const configuredRoutes = createCouplingRuntimeRoutes(configuredRouteOptions);
    globalThis.fetch = (async () =>
      new Response('private stack trace', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      })) as unknown as typeof fetch;

    const res = await configuredRoutes.handleRequest(
      new Request('https://api.test/v1/licenses/coupling-runtime?token=abc')
    );

    expect(res?.status).toBe(502);
    expect(res?.headers.get('Content-Type')).toContain('application/json');
    const json = (await res?.json()) as { error: string };
    expect(json.error).toBe('Coupling runtime download failed');
  });
});
