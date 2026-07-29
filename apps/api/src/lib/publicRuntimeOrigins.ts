import { normalizePublicApiBaseUrl } from '@yucp/shared';

export interface PublicRuntimeOriginEnvironment {
  API_BASE_URL?: string;
  FRONTEND_URL?: string;
  NODE_ENV?: string;
  SITE_URL?: string;
}

export interface PublicRuntimeOrigins {
  frontendUrl: string;
  publicApiBaseUrl: string;
  siteUrl: string;
}

function normalizeHttpOrigin(value: string, name: string): string {
  const url = new URL(value.trim());
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTP origin`);
  }
  return url.origin;
}

export function resolvePublicRuntimeOrigins(
  env: PublicRuntimeOriginEnvironment,
  publicApiOverride?: string
): PublicRuntimeOrigins {
  const isProduction = env.NODE_ENV === 'production';
  const configuredSiteUrl = env.SITE_URL?.trim() || env.FRONTEND_URL?.trim();
  if (isProduction && !configuredSiteUrl) {
    throw new Error('SITE_URL must be configured in production');
  }
  const siteUrl = normalizeHttpOrigin(configuredSiteUrl || 'http://localhost:3001', 'SITE_URL');
  const frontendUrl = normalizeHttpOrigin(env.FRONTEND_URL?.trim() || siteUrl, 'FRONTEND_URL');
  const configuredApiBaseUrl = publicApiOverride?.trim() || env.API_BASE_URL?.trim();
  if (isProduction && !configuredApiBaseUrl) {
    throw new Error('API_BASE_URL must be configured in production');
  }
  const publicApiBaseUrl = configuredApiBaseUrl
    ? normalizePublicApiBaseUrl(configuredApiBaseUrl)
    : siteUrl;

  return { frontendUrl, publicApiBaseUrl, siteUrl };
}
