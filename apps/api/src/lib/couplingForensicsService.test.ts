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

    it(`maps unreachable ${name} requests to coupling service errors`, async () => {
      const fetchMock = mock(async () => {
        throw new Error(`${name} network down`);
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
      ).rejects.toThrow(`Coupling service is unreachable: ${name} network down`);
    });
  }
});
