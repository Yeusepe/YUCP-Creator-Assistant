import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadRootAuthState,
  logRootRenderError,
  resolveRequiredConvexUrl,
} from '@/lib/webDiagnostics';

describe('web diagnostics', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sets the SSR auth token on the server HTTP client when bootstrap succeeds', async () => {
    const setAuth = vi.fn();

    const result = await loadRootAuthState({
      convexQueryClient: {
        serverHttpClient: {
          setAuth,
        },
      },
      getAuthToken: async () => 'test-jwt-token',
      location: {
        pathname: '/sign-in',
      },
      env: {
        NODE_ENV: 'test',
        CONVEX_URL: 'https://rare-squid-409.convex.cloud',
        CONVEX_SITE_URL: 'https://rare-squid-409.convex.site',
      },
    });

    expect(setAuth).toHaveBeenCalledWith('test-jwt-token');
    expect(result).toEqual({
      isAuthenticated: true,
      token: 'test-jwt-token',
    });
  });

  it('logs sanitized diagnostics and rethrows when SSR auth bootstrap fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('Unable to connect. Is the computer able to access the url?');

    await expect(
      loadRootAuthState({
        convexQueryClient: {},
        getAuthToken: async () => {
          throw error;
        },
        location: {
          pathname: '/sign-in',
        },
        env: {
          NODE_ENV: 'production',
          CONVEX_URL: 'https://rare-squid-409.convex.cloud',
          CONVEX_SITE_URL: 'https://rare-squid-409.convex.site',
        },
      })
    ).rejects.toThrow(error);

    expect(consoleSpy).toHaveBeenCalledWith(
      '[web] Root auth bootstrap failed',
      expect.objectContaining({
        phase: 'root-beforeLoad',
        route: '/sign-in',
        nodeEnv: 'production',
        hasConvexUrl: true,
        convexUrlHost: 'rare-squid-409.convex.cloud',
        hasConvexSiteUrl: true,
        convexSiteUrlHost: 'rare-squid-409.convex.site',
        error: expect.objectContaining({
          name: 'Error',
          message: 'Unable to connect. Is the computer able to access the url?',
        }),
      })
    );
  });

  it('logs missing router Convex configuration before throwing', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      resolveRequiredConvexUrl(undefined, {
        env: {
          NODE_ENV: 'production',
          CONVEX_SITE_URL: 'https://rare-squid-409.convex.site',
        },
      })
    ).toThrow('CONVEX_URL is not available. Ensure it is set in your Infisical environment.');

    expect(consoleSpy).toHaveBeenCalledWith(
      '[web] Router initialization failed',
      expect.objectContaining({
        phase: 'router-init',
        nodeEnv: 'production',
        hasConvexUrl: false,
        hasConvexSiteUrl: true,
        convexSiteUrlHost: 'rare-squid-409.convex.site',
        error: expect.objectContaining({
          message: 'CONVEX_URL is not available. Ensure it is set in your Infisical environment.',
        }),
      })
    );
  });

  it('logs root render errors once per error object', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('render failed');

    logRootRenderError(error, {
      route: '/sign-in',
      env: {
        NODE_ENV: 'production',
      },
    });
    logRootRenderError(error, {
      route: '/sign-in',
      env: {
        NODE_ENV: 'production',
      },
    });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[web] Root render error',
      expect.objectContaining({
        phase: 'root-error-boundary',
        route: '/sign-in',
        nodeEnv: 'production',
        error: expect.objectContaining({
          message: 'render failed',
        }),
      })
    );
  });
});

describe('web diagnostics integration', () => {
  const diagnosticsSource = readFileSync(
    join(__dirname, '../../src/lib/webDiagnostics.ts'),
    'utf8'
  );
  const rootSource = readFileSync(join(__dirname, '../../src/routes/__root.tsx'), 'utf8');
  const routerSource = readFileSync(join(__dirname, '../../src/router.tsx'), 'utf8');
  const signInSource = readFileSync(join(__dirname, '../../src/routes/sign-in.tsx'), 'utf8');
  const signInRedirectSource = readFileSync(
    join(__dirname, '../../src/routes/sign-in-redirect.tsx'),
    'utf8'
  );
  const oauthLoginSource = readFileSync(
    join(__dirname, '../../src/routes/oauth/login.tsx'),
    'utf8'
  );

  it('uses the auth bootstrap helper in the root route', () => {
    expect(rootSource).toContain('loadRootAuthState');
  });

  it('keeps the shared diagnostics module free of server-only auth imports', () => {
    expect(diagnosticsSource).not.toContain(`@/lib/auth-server`);
  });

  it('uses the root render logger in the root error boundary', () => {
    expect(rootSource).toContain('logRootRenderError');
  });

  it('uses the required Convex URL helper during router setup', () => {
    expect(routerSource).toContain('resolveRequiredConvexUrl');
  });

  it('logs sign-in flow failures through the shared logger', () => {
    expect(signInSource).toContain('logWebError');
    expect(signInRedirectSource).toContain('logWebError');
    expect(oauthLoginSource).toContain('logWebError');
  });
});
