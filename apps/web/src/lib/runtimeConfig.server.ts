import { getRequestUrl } from '@tanstack/react-start/server';
import { createPublicRuntimeConfig, type PublicRuntimeConfig } from '@/lib/runtimeConfig';

export function getPublicRuntimeConfigForRequest(): PublicRuntimeConfig {
  const requestUrl = getRequestUrl({
    xForwardedHost: true,
    xForwardedProto: true,
  }).toString();

  return createPublicRuntimeConfig({
    requestUrl,
    frontendUrl: process.env.FRONTEND_URL,
    siteUrl: process.env.SITE_URL,
  });
}
