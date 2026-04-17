import { getRequestUrl } from '@tanstack/react-start/server';
import { createPublicRuntimeConfig, type PublicRuntimeConfig } from '@/lib/runtimeConfig';
import { getWebEnv, getWebRuntimeEnv } from '@/lib/server/runtimeEnv';

export function getPublicRuntimeConfigForRequest(): PublicRuntimeConfig {
  const env = getWebRuntimeEnv();
  const requestUrl = getRequestUrl({
    xForwardedHost: true,
    xForwardedProto: true,
  }).toString();

  return createPublicRuntimeConfig({
    buildId: getWebEnv('BUILD_ID', env),
    convexSiteUrl: getWebEnv('CONVEX_SITE_URL', env),
    convexUrl: getWebEnv('CONVEX_URL', env),
    requestUrl,
    frontendUrl: getWebEnv('FRONTEND_URL', env),
    hyperdxApiKey: getWebEnv('HYPERDX_API_KEY', env),
    hyperdxAppUrl: getWebEnv('HYPERDX_APP_URL', env),
    hyperdxOtlpHttpUrl:
      getWebEnv('HYPERDX_OTLP_HTTP_URL', env) ?? getWebEnv('OTEL_EXPORTER_OTLP_ENDPOINT', env),
    siteUrl: getWebEnv('SITE_URL', env),
  });
}
