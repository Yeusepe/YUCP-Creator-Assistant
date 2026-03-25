import {
  buildPublicAuthIssuer as buildPublicAuthIssuerFromApiBaseUrl,
  resolveConfiguredApiBaseUrl,
} from '../../packages/shared/src/publicAuthority';

export const buildPublicAuthIssuer = buildPublicAuthIssuerFromApiBaseUrl;

export function resolveConfiguredPublicApiBaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  return resolveConfiguredApiBaseUrl(env);
}

export function resolveConfiguredPublicAuthIssuer(
  env: Record<string, string | undefined> = process.env
): string {
  const apiBaseUrl = resolveConfiguredPublicApiBaseUrl(env);
  if (!apiBaseUrl) {
    throw new Error('API_BASE_URL is required');
  }
  return buildPublicAuthIssuer(apiBaseUrl);
}
