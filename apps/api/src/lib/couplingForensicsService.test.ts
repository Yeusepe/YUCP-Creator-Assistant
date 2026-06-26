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
