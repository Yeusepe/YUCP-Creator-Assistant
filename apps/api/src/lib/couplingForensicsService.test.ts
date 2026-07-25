import { afterEach, describe, expect, it, mock } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  type CouplingAttributionCandidate,
  type CouplingForensicsServiceConfig,
  CouplingServiceConfigurationError,
  runCouplingAttribution,
} from './couplingForensicsService';

const originalFetch = globalThis.fetch;
const assetFixturePath = fileURLToPath(new URL(import.meta.url));
const config: CouplingForensicsServiceConfig = {
  baseUrl: 'https://coupling.internal',
  sharedSecret: ['unit', 'test', 'coupling', 'bearer'].join('-'),
};
const primaryCandidate: CouplingAttributionCandidate = {
  algorithmVersion: 'png-dct-qim-v2',
  attributionId: 'attribution-1',
  attributionTokenHash: '0'.repeat(64),
  buyerSubjectPseudonym: 'buyer-subject-1',
  capabilityId: 'capability-1',
  creatorId: 'creator-1',
  jobId: 'job-1',
  keyEpoch: 1,
  leaseGeneration: 1,
  materializerType: 'png',
  normalizedPath: 'Assets/Character/body.png',
  outputFormat: 'zip',
  pluginVersion: 'png-plugin-2',
  protectedSourceRoot: '1'.repeat(64),
  releaseRoot: '2'.repeat(64),
  sourceSha256: '3'.repeat(64),
};
const candidates: CouplingAttributionCandidate[] = [primaryCandidate];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('runCouplingAttribution', () => {
  it('rejects duplicate attribution input paths before correlating service results', async () => {
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          schemaVersion: 2,
          results: [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              attributionId: 'attribution-1',
              buyerSubjectPseudonym: 'buyer-subject-1',
              matched: true,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      runCouplingAttribution(
        [
          {
            assetPath: 'Assets/Character/body.png',
            assetType: 'png',
            filePath: assetFixturePath,
          },
          {
            assetPath: 'Assets/Character/body.png',
            assetType: 'png',
            filePath: assetFixturePath,
          },
        ],
        candidates,
        config
      )
    ).rejects.toThrow('Duplicate asset path in attribution input: Assets/Character/body.png');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses an abortable non-redirecting request for attribution calls', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requestInit = init;
      return new Response(
        JSON.stringify({
          schemaVersion: 2,
          results: [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              attributionId: 'attribution-1',
              buyerSubjectPseudonym: 'buyer-subject-1',
              matched: true,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runCouplingAttribution(
      [
        {
          assetPath: 'Assets/Character/body.png',
          assetType: 'png',
          filePath: assetFixturePath,
        },
      ],
      candidates,
      config
    );

    expect(requestUrl).toBe('https://coupling.internal/v2/internal/coupling/attribution/evaluate');
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      candidates,
      schemaVersion: 2,
    });
    expect(result).toEqual([
      {
        assetPath: 'Assets/Character/body.png',
        assetType: 'png',
        decoderKind: 'png',
        matchedAttributionId: 'attribution-1',
        matchedBuyerSubjectPseudonym: 'buyer-subject-1',
        preclassification: 'decoded',
      },
    ]);
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(requestInit?.redirect).toBe('error');
  });

  it('uses bounded attribution batches and omits assets without stored candidates', async () => {
    const secondCandidate: CouplingAttributionCandidate = {
      ...primaryCandidate,
      attributionId: 'attribution-2',
      normalizedPath: 'Assets/Character/detail.png',
    };
    const requestBodies: Array<{
      assets: Array<{ assetPath: string }>;
      candidates: CouplingAttributionCandidate[];
      schemaVersion: number;
    }> = [];
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as (typeof requestBodies)[number];
      requestBodies.push(body);
      return new Response(
        JSON.stringify({
          schemaVersion: 2,
          results: body.assets.map((asset) => ({
            assetPath: asset.assetPath,
            assetType: 'png',
            matched: false,
          })),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runCouplingAttribution(
      [
        {
          assetPath: 'Assets/Character/body.png',
          assetType: 'png',
          filePath: assetFixturePath,
        },
        {
          assetPath: 'Assets/Character/detail.png',
          assetType: 'png',
          filePath: assetFixturePath,
        },
        {
          assetPath: 'Assets/Character/unprotected.png',
          assetType: 'png',
          filePath: assetFixturePath,
        },
      ],
      [primaryCandidate, secondCandidate],
      { ...config, requestMaxBytes: 40_000 }
    );

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies.map((body) => body.assets.map((asset) => asset.assetPath))).toEqual([
      ['Assets/Character/body.png'],
      ['Assets/Character/detail.png'],
    ]);
    expect(
      requestBodies.map((body) => body.candidates.map((candidate) => candidate.attributionId))
    ).toEqual([['attribution-1'], ['attribution-2']]);
    expect(requestBodies.every((body) => Buffer.byteLength(JSON.stringify(body)) <= 40_000)).toBe(
      true
    );
    expect(result).toEqual([
      {
        assetPath: 'Assets/Character/body.png',
        assetType: 'png',
        decoderKind: 'png',
        preclassification: 'no-signal',
      },
      {
        assetPath: 'Assets/Character/detail.png',
        assetType: 'png',
        decoderKind: 'png',
        preclassification: 'no-signal',
      },
      {
        assetPath: 'Assets/Character/unprotected.png',
        assetType: 'png',
        decoderKind: 'png',
        preclassification: 'no-signal',
      },
    ]);
  });

  it('rejects non-http attribution base URLs before sending requests', async () => {
    const fetchMock = mock(async () => {
      throw new Error('Attribution must not fetch non-http service URLs');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      runCouplingAttribution(
        [
          {
            assetPath: 'Assets/Character/body.png',
            assetType: 'png',
            filePath: assetFixturePath,
          },
        ],
        candidates,
        { ...config, baseUrl: 'file:///tmp/coupling' }
      )
    ).rejects.toThrow('Coupling service base URL must use http or https');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves attribution URL configuration errors for route-level handling', async () => {
    const fetchMock = mock(async () => {
      throw new Error('Attribution must not fetch invalid service URLs');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let caught: unknown;
    try {
      await runCouplingAttribution(
        [
          {
            assetPath: 'Assets/Character/body.png',
            assetType: 'png',
            filePath: assetFixturePath,
          },
        ],
        candidates,
        { ...config, baseUrl: 'file:///tmp/coupling' }
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CouplingServiceConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects credential-bearing attribution base URLs before sending requests', async () => {
    const fetchMock = mock(async () => {
      throw new Error('Attribution must not fetch credential-bearing service URLs');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      runCouplingAttribution(
        [
          {
            assetPath: 'Assets/Character/body.png',
            assetType: 'png',
            filePath: assetFixturePath,
          },
        ],
        candidates,
        { ...config, baseUrl: 'https://user:pass@coupling.internal' }
      )
    ).rejects.toThrow('Coupling service base URL must not include credentials');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects metadata-IP attribution base URLs before sending requests', async () => {
    const fetchMock = mock(async () => {
      throw new Error('Attribution must not fetch metadata service URLs');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      runCouplingAttribution(
        [
          {
            assetPath: 'Assets/Character/body.png',
            assetType: 'png',
            filePath: assetFixturePath,
          },
        ],
        candidates,
        { ...config, baseUrl: 'http://169.254.169.254' }
      )
    ).rejects.toThrow('Coupling service base URL host is not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects trailing-dot metadata attribution base URLs before sending requests', async () => {
    const fetchMock = mock(async () => {
      throw new Error('Attribution must not fetch trailing-dot metadata service URLs');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      runCouplingAttribution(
        [
          {
            assetPath: 'Assets/Character/body.png',
            assetType: 'png',
            filePath: assetFixturePath,
          },
        ],
        candidates,
        { ...config, baseUrl: 'http://metadata.google.internal.' }
      )
    ).rejects.toThrow('Coupling service base URL host is not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects bracketed IPv6 metadata attribution base URLs before sending requests', async () => {
    const fetchMock = mock(async () => {
      throw new Error('Attribution must not fetch bracketed metadata service URLs');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    for (const baseUrl of [
      'http://[fe80::1]',
      'http://[fe90::1]',
      'http://[::ffff:169.254.169.254]',
      'http://[fd00:ec2::254]',
    ]) {
      await expect(
        runCouplingAttribution(
          [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              filePath: assetFixturePath,
            },
          ],
          candidates,
          { ...config, baseUrl }
        )
      ).rejects.toThrow('Coupling service base URL host is not allowed');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON attribution responses', async () => {
    const fetchMock = mock(async () => {
      return new Response('not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      runCouplingAttribution(
        [
          {
            assetPath: 'Assets/Character/body.png',
            assetType: 'png',
            filePath: assetFixturePath,
          },
        ],
        candidates,
        config
      )
    ).rejects.toThrow('Coupling service returned invalid JSON');
  });

  it('rejects non-array attribution results as a controlled upstream protocol error', async () => {
    const fetchMock = mock(async () => {
      return new Response(JSON.stringify({ results: {}, schemaVersion: 2 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      runCouplingAttribution(
        [
          {
            assetPath: 'Assets/Character/body.png',
            assetType: 'png',
            filePath: assetFixturePath,
          },
        ],
        candidates,
        config
      )
    ).rejects.toThrow('Coupling service returned invalid results');
  });

  it('rejects oversized attribution response bodies before parsing JSON', async () => {
    const fetchMock = mock(async () => {
      return new Response(JSON.stringify({ results: [], schemaVersion: 2 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      runCouplingAttribution(
        [
          {
            assetPath: 'Assets/Character/body.png',
            assetType: 'png',
            filePath: assetFixturePath,
          },
        ],
        candidates,
        { ...config, responseMaxBytes: 16 }
      )
    ).rejects.toThrow('Coupling service response is too large');
  });

  it('maps attribution network failures without exposing raw transport details', async () => {
    const fetchMock = mock(async () => {
      throw new Error('dial tcp coupling.internal:443: network down');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let caught: unknown;
    try {
      await runCouplingAttribution(
        [
          {
            assetPath: 'Assets/Character/body.png',
            assetType: 'png',
            filePath: assetFixturePath,
          },
        ],
        candidates,
        config
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toBe('Coupling service is unreachable');
    expect(message).not.toContain('coupling.internal');
    expect(message).not.toContain('network down');
  });

  it('does not include uploaded asset paths when rejecting unknown attribution records', async () => {
    const unsafeAssetPath = 'Assets/Customers/buyer@example.com/private.png';
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          schemaVersion: 2,
          results: [
            {
              assetPath: unsafeAssetPath,
              assetType: 'png',
              attributionId: 'unknown-attribution',
              buyerSubjectPseudonym: 'buyer-subject-1',
              matched: true,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let caught: unknown;
    try {
      await runCouplingAttribution(
        [
          {
            assetPath: unsafeAssetPath,
            assetType: 'png',
            filePath: assetFixturePath,
          },
        ],
        [{ ...primaryCandidate, normalizedPath: unsafeAssetPath }],
        config
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toBe('Coupling service returned an unknown matched candidate');
    expect(message).not.toContain(unsafeAssetPath);
  });

  it('rejects matched attribution responses without exact stored attribution evidence', async () => {
    const unsafeAssetPath = 'Assets/Customers/buyer@example.com/private.png';

    for (const result of [
      {
        attributionId: undefined,
        buyerSubjectPseudonym: 'buyer-subject-1',
      },
      {
        attributionId: 'attribution-1',
        buyerSubjectPseudonym: 'different-subject',
      },
    ]) {
      const fetchMock = mock(async () => {
        return new Response(
          JSON.stringify({
            schemaVersion: 2,
            results: [
              {
                assetPath: unsafeAssetPath,
                assetType: 'png',
                ...result,
                matched: true,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      let caught: unknown;
      try {
        await runCouplingAttribution(
          [
            {
              assetPath: unsafeAssetPath,
              assetType: 'png',
              filePath: assetFixturePath,
            },
          ],
          [{ ...primaryCandidate, normalizedPath: unsafeAssetPath }],
          config
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toBe('Coupling service returned an unknown matched candidate');
      expect(message).not.toContain(unsafeAssetPath);
    }
  });

  it('does not include unknown uploaded asset paths in attribution validation errors', async () => {
    const unsafeAssetPath = 'Assets/Customers/buyer@example.com/private.png';
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          schemaVersion: 2,
          results: [
            {
              assetPath: unsafeAssetPath,
              assetType: 'png',
              matched: false,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let caught: unknown;
    try {
      await runCouplingAttribution(
        [
          {
            assetPath: 'Assets/Character/body.png',
            assetType: 'png',
            filePath: assetFixturePath,
          },
        ],
        candidates,
        config
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toBe('Coupling service returned an unknown asset path');
    expect(message).not.toContain(unsafeAssetPath);
  });

  it('does not include duplicate uploaded asset paths in attribution validation errors', async () => {
    const unsafeAssetPath = 'Assets/Customers/buyer@example.com/private.png';
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          schemaVersion: 2,
          results: [
            {
              assetPath: unsafeAssetPath,
              assetType: 'png',
              matched: false,
            },
            {
              assetPath: unsafeAssetPath,
              assetType: 'png',
              matched: false,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let caught: unknown;
    try {
      await runCouplingAttribution(
        [
          {
            assetPath: unsafeAssetPath,
            assetType: 'png',
            filePath: assetFixturePath,
          },
        ],
        [{ ...primaryCandidate, normalizedPath: unsafeAssetPath }],
        config
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toBe('Coupling service returned a duplicate asset path');
    expect(message).not.toContain(unsafeAssetPath);
  });

  it('maps attribution timeout aborts to 504 errors', async () => {
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('fetch aborted')));
        setTimeout(
          () =>
            resolve(
              new Response(JSON.stringify({ results: [], schemaVersion: 2 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              })
            ),
          100
        );
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      Promise.race([
        runCouplingAttribution(
          [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              filePath: assetFixturePath,
            },
          ],
          candidates,
          { ...config, attributionTimeoutMs: 1 }
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout was not enforced')), 50)
        ),
      ])
    ).rejects.toThrow('Coupling attribution timed out');
  });

  it('prefers the attribution-specific timeout over the generic request timeout', async () => {
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('fetch aborted')));
        setTimeout(
          () =>
            resolve(
              new Response(JSON.stringify({ results: [], schemaVersion: 2 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              })
            ),
          100
        );
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      Promise.race([
        runCouplingAttribution(
          [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              filePath: assetFixturePath,
            },
          ],
          candidates,
          { ...config, requestTimeoutMs: 100, attributionTimeoutMs: 1 }
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('attribution timeout was not preferred')), 50)
        ),
      ])
    ).rejects.toThrow('Coupling attribution timed out');
  });

  it('keeps the attribution timeout active while reading the response body', async () => {
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener('abort', () =>
              controller.error(new Error('body read aborted'))
            );
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      Promise.race([
        runCouplingAttribution(
          [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              filePath: assetFixturePath,
            },
          ],
          candidates,
          { ...config, attributionTimeoutMs: 1 }
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('body timeout was not enforced')), 50)
        ),
      ])
    ).rejects.toThrow('Coupling attribution timed out');
  });
});
