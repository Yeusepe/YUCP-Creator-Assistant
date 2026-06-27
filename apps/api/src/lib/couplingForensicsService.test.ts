import { afterEach, describe, expect, it, mock } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  type CouplingAttributionCandidate,
  type CouplingForensicsServiceConfig,
  CouplingServiceConfigurationError,
  runCouplingAttribution,
  runCouplingForensicsScan,
  runCouplingForensicsScore,
} from './couplingForensicsService';

const originalFetch = globalThis.fetch;
const assetFixturePath = fileURLToPath(new URL(import.meta.url));
const config: CouplingForensicsServiceConfig = {
  baseUrl: 'https://coupling.internal',
  sharedSecret: ['unit', 'test', 'coupling', 'bearer'].join('-'),
};
const candidates: CouplingAttributionCandidate[] = [
  {
    assetPath: 'Assets/Character/body.png',
    licenseSubject: 'license-subject-1',
    tokenHash: '0'.repeat(64),
  },
];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('runCouplingAttribution', () => {
  it('rejects duplicate attribution input paths before correlating service results', async () => {
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          results: [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              matched: false,
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
    let requestInit: RequestInit | undefined;
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return new Response(
        JSON.stringify({
          results: [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              matched: false,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

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

    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(requestInit?.redirect).toBe('error');
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
      return new Response(JSON.stringify({ results: {} }), {
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
      return new Response(JSON.stringify({ requestId: 'x'.repeat(64), results: [] }), {
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

  it('does not include uploaded asset paths when rejecting invalid matched license subjects', async () => {
    const unsafeAssetPath = 'Assets/Customers/buyer@example.com/private.png';
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          results: [
            {
              assetPath: unsafeAssetPath,
              assetType: 'png',
              matched: true,
              tokenHex: 'deadbeef',
              matchedLicenseSubject: 'not-a-sha256-subject',
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
        [{ ...candidates[0], assetPath: unsafeAssetPath }],
        config
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toBe('Coupling service returned an invalid matched license subject');
    expect(message).not.toContain(unsafeAssetPath);
  });

  it('rejects matched attribution responses without a valid recovered token', async () => {
    const unsafeAssetPath = 'Assets/Customers/buyer@example.com/private.png';

    for (const tokenHex of [undefined, 'not-a-token']) {
      const fetchMock = mock(async () => {
        return new Response(
          JSON.stringify({
            results: [
              {
                assetPath: unsafeAssetPath,
                assetType: 'png',
                matched: true,
                tokenHex,
                matchedLicenseSubject: 'f'.repeat(64),
                matchedCandidateAssetPath: unsafeAssetPath,
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
          [{ ...candidates[0], assetPath: unsafeAssetPath, licenseSubject: 'f'.repeat(64) }],
          config
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toBe('Coupling service returned an invalid token');
      expect(message).not.toContain(unsafeAssetPath);
    }
  });

  it('does not include unknown uploaded asset paths in attribution validation errors', async () => {
    const unsafeAssetPath = 'Assets/Customers/buyer@example.com/private.png';
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
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
        [{ ...candidates[0], assetPath: unsafeAssetPath }],
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
              new Response(JSON.stringify({ results: [] }), {
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
              new Response(JSON.stringify({ results: [] }), {
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

describe('legacy coupling service scan paths', () => {
  for (const [name, run, expectedUrl] of [
    ['score', runCouplingForensicsScore, 'https://coupling.internal/v1/coupling/forensic-score'],
    ['scan', runCouplingForensicsScan, 'https://coupling.internal/v1/coupling/scan'],
  ] as const) {
    it(`uses a non-redirecting request for ${name}`, async () => {
      let requestUrl = '';
      let requestInit: RequestInit | undefined;
      const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
        requestUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        requestInit = init;
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await run(
        [
          {
            assetPath: 'Assets/Character/body.png',
            assetType: 'png',
            filePath: assetFixturePath,
          },
        ],
        config
      );

      expect(requestUrl).toBe(expectedUrl);
      expect(requestInit?.redirect).toBe('error');
      expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    });

    it(`rejects invalid ${name} base URLs before sending requests`, async () => {
      const fetchMock = mock(async () => {
        throw new Error(`${name} must not fetch invalid service URLs`);
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      for (const baseUrl of ['file:///tmp/coupling', 'https://user:pass@coupling.internal']) {
        await expect(
          run(
            [
              {
                assetPath: 'Assets/Character/body.png',
                assetType: 'png',
                filePath: assetFixturePath,
              },
            ],
            { ...config, baseUrl }
          )
        ).rejects.toThrow('Coupling service base URL');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it(`rejects invalid JSON ${name} responses`, async () => {
      const fetchMock = mock(async () => {
        return new Response('not-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        run(
          [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              filePath: assetFixturePath,
            },
          ],
          config
        )
      ).rejects.toThrow('Coupling service returned invalid JSON');
    });

    it(`maps unreachable ${name} requests to generic coupling service errors`, async () => {
      const fetchMock = mock(async () => {
        throw new Error(`dial tcp ${name}.coupling.internal:443: network down`);
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      let caught: unknown;
      try {
        await run(
          [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              filePath: assetFixturePath,
            },
          ],
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

    it(`does not apply attribution-specific timeouts to ${name} requests`, async () => {
      const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        return await new Promise<Response>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('fetch aborted')));
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ results: [] }), {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                })
              ),
            25
          );
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        Promise.race([
          run(
            [
              {
                assetPath: 'Assets/Character/body.png',
                assetType: 'png',
                filePath: assetFixturePath,
              },
            ],
            { ...config, attributionTimeoutMs: 1 }
          ),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('legacy request did not finish')), 100)
          ),
        ])
      ).resolves.toBeDefined();
    });

    it(`maps timed-out ${name} requests to 504 coupling service errors`, async () => {
      const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        return await new Promise<Response>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('fetch aborted')));
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ results: [] }), {
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
          run(
            [
              {
                assetPath: 'Assets/Character/body.png',
                assetType: 'png',
                filePath: assetFixturePath,
              },
            ],
            { ...config, requestTimeoutMs: 1 }
          ),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout was not enforced')), 50)
          ),
        ])
      ).rejects.toThrow(
        `Coupling ${name === 'score' ? 'forensic-score' : 'service scan'} timed out`
      );
    });
  }

  it('does not include uploaded asset paths in scan validation errors', async () => {
    const unsafeAssetPath = 'Assets/Customers/buyer@example.com/private.png';
    const cases = [
      {
        result: {
          assetPath: unsafeAssetPath,
          assetType: 'png',
          tokenHex: 'deadbeef',
          tokenLength: 8,
        },
        expectedMessage: 'Coupling service returned an unknown asset path',
      },
      {
        result: {
          assetPath: 'Assets/Character/body.png',
          assetType: 'png',
          tokenHex: 'not-a-token',
          tokenLength: 11,
        },
        expectedMessage: 'Coupling service returned an invalid token',
      },
      {
        result: {
          assetPath: 'Assets/Character/body.png',
          assetType: 'png',
          tokenHex: 'deadbeef',
          tokenLength: 7,
        },
        expectedMessage: 'Coupling service token length mismatch',
      },
    ];

    for (const testCase of cases) {
      const fetchMock = mock(async () => {
        return new Response(JSON.stringify({ results: [testCase.result] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      let caught: unknown;
      try {
        await runCouplingForensicsScan(
          [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              filePath: assetFixturePath,
            },
          ],
          config
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toBe(testCase.expectedMessage);
      expect(message).not.toContain(unsafeAssetPath);
      expect(message).not.toContain('Assets/Character/body.png');
    }
  });
});
