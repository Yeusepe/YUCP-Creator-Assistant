import { describe, expect, it } from 'vitest';
import {
  createPublicRuntimeConfig,
  createPublicRuntimeConfigFromEnv,
  resolveBrowserAuthBaseUrl,
} from '@/lib/runtimeConfig';

describe('resolveBrowserAuthBaseUrl', () => {
  it('prefers the current SSR request origin over configured env origins', () => {
    expect(
      resolveBrowserAuthBaseUrl({
        requestUrl: 'http://localhost:3000/sign-in?redirectTo=%2Fdashboard',
        siteUrl: 'http://localhost:3001',
        frontendUrl: 'http://localhost:3001',
      })
    ).toBe('http://localhost:3000');
  });

  it('falls back to FRONTEND_URL when the request URL and SITE_URL are missing or invalid', () => {
    expect(
      resolveBrowserAuthBaseUrl({
        requestUrl: 'not-a-url',
        siteUrl: 'not-a-url',
        frontendUrl: 'http://localhost:3001/dashboard',
      })
    ).toBe('http://localhost:3001');
  });

  it('uses the provided fallback when no configured origin is valid', () => {
    expect(
      resolveBrowserAuthBaseUrl({
        requestUrl: undefined,
        siteUrl: undefined,
        frontendUrl: undefined,
        fallback: 'http://localhost:4321/path',
      })
    ).toBe('http://localhost:4321');
  });
});

describe('createPublicRuntimeConfig', () => {
  it('carries the public worker config that the browser needs at runtime', () => {
    expect(
      createPublicRuntimeConfig({
        buildId: 'build-123',
        convexSiteUrl: ' https://rare-squid-409.convex.site ',
        convexUrl: ' https://rare-squid-409.convex.cloud ',
        hyperdxApiKey: ' key-123 ',
        hyperdxAppUrl: ' https://analytics.admin.yucp.club ',
        hyperdxOtlpHttpUrl: ' https://analytics.admin.yucp.club/ingest ',
        siteUrl: 'https://verify.creators.yucp.club',
      })
    ).toEqual({
      automaticSetupEnabled: false,
      browserAuthBaseUrl: 'https://verify.creators.yucp.club',
      buildId: 'build-123',
      convexSiteUrl: 'https://rare-squid-409.convex.site',
      convexUrl: 'https://rare-squid-409.convex.cloud',
      hyperdxApiKey: 'key-123',
      hyperdxAppUrl: 'https://analytics.admin.yucp.club',
      hyperdxOtlpHttpUrl: 'https://analytics.admin.yucp.club/ingest',
      privateVpmEnabled: false,
    });
  });

  it('falls back to dev when no build id is provided', () => {
    expect(
      createPublicRuntimeConfig({
        siteUrl: 'https://verify.creators.yucp.club',
      }).buildId
    ).toBe('dev');
  });

  it('maps env-style keys into the public runtime config once', () => {
    expect(
      createPublicRuntimeConfigFromEnv(
        {
          BUILD_ID: 'build-234',
          CONVEX_SITE_URL: 'https://rare-squid-409.convex.site',
          CONVEX_URL: 'https://rare-squid-409.convex.cloud',
          FRONTEND_URL: 'https://verify.creators.yucp.club',
          HYPERDX_API_KEY: 'key-234',
          HYPERDX_APP_URL: 'https://analytics.admin.yucp.club',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://analytics.admin.yucp.club/ingest',
          YUCP_ENABLE_AUTOMATIC_SETUP: 'true',
          YUCP_ENABLE_PRIVATE_VPM: 'true',
        },
        'https://verify.creators.yucp.club/dashboard'
      )
    ).toEqual({
      automaticSetupEnabled: true,
      browserAuthBaseUrl: 'https://verify.creators.yucp.club',
      buildId: 'build-234',
      convexSiteUrl: 'https://rare-squid-409.convex.site',
      convexUrl: 'https://rare-squid-409.convex.cloud',
      hyperdxApiKey: 'key-234',
      hyperdxAppUrl: 'https://analytics.admin.yucp.club',
      hyperdxOtlpHttpUrl: 'https://analytics.admin.yucp.club/ingest',
      privateVpmEnabled: true,
    });
  });

  it('falls back to OTEL_EXPORTER_OTLP_ENDPOINT when HYPERDX_OTLP_HTTP_URL is blank', () => {
    expect(
      createPublicRuntimeConfigFromEnv({
        HYPERDX_OTLP_HTTP_URL: '   ',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://analytics.admin.yucp.club/otlp',
        SITE_URL: 'https://verify.creators.yucp.club',
      })
    ).toEqual({
      automaticSetupEnabled: false,
      browserAuthBaseUrl: 'https://verify.creators.yucp.club',
      buildId: 'dev',
      hyperdxOtlpHttpUrl: 'https://analytics.admin.yucp.club/otlp',
      privateVpmEnabled: false,
    });
  });
});
