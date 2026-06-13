import { isAutomaticSetupEnabled, isPrivateVpmEnabled } from '@yucp/shared/featureFlags';
import { createContext, type ReactNode, useContext } from 'react';

const LOCAL_FALLBACK_SITE_URL = 'http://localhost:3000';

export interface PublicRuntimeConfig {
  automaticSetupEnabled: boolean;
  browserAuthBaseUrl: string;
  buildId: string;
  convexSiteUrl?: string;
  convexUrl?: string;
  hyperdxApiKey?: string;
  hyperdxAppUrl?: string;
  hyperdxOtlpHttpUrl?: string;
  privateVpmEnabled?: boolean;
}

export interface PublicRuntimeEnvSource {
  BUILD_ID?: string | null;
  CONVEX_SITE_URL?: string | null;
  CONVEX_URL?: string | null;
  FRONTEND_URL?: string | null;
  HYPERDX_API_KEY?: string | null;
  HYPERDX_APP_URL?: string | null;
  HYPERDX_OTLP_HTTP_URL?: string | null;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string | null;
  SITE_URL?: string | null;
  YUCP_ENABLE_AUTOMATIC_SETUP?: string | null;
  YUCP_ENABLE_PRIVATE_VPM?: string | null;
}

const PUBLIC_RUNTIME_ENV_KEYS = [
  'BUILD_ID',
  'CONVEX_SITE_URL',
  'CONVEX_URL',
  'FRONTEND_URL',
  'HYPERDX_API_KEY',
  'HYPERDX_APP_URL',
  'HYPERDX_OTLP_HTTP_URL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'SITE_URL',
  'YUCP_ENABLE_AUTOMATIC_SETUP',
  'YUCP_ENABLE_PRIVATE_VPM',
] as const;

declare global {
  interface Window {
    __YUCP_PUBLIC_RUNTIME_CONFIG__?: PublicRuntimeConfig;
  }
}

function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function normalizeOptionalValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolveBrowserAuthBaseUrl({
  requestUrl,
  siteUrl,
  frontendUrl,
  fallback = LOCAL_FALLBACK_SITE_URL,
}: Readonly<{
  requestUrl?: string | URL | null;
  siteUrl?: string | null;
  frontendUrl?: string | null;
  fallback?: string;
}>): string {
  return (
    normalizeOrigin(requestUrl ? requestUrl.toString() : null) ??
    normalizeOrigin(frontendUrl) ??
    normalizeOrigin(siteUrl) ??
    normalizeOrigin(fallback) ??
    LOCAL_FALLBACK_SITE_URL
  );
}

export function createPublicRuntimeConfig({
  automaticSetupEnabled,
  requestUrl,
  siteUrl,
  frontendUrl,
  buildId,
  convexSiteUrl,
  convexUrl,
  fallback,
  hyperdxApiKey,
  hyperdxAppUrl,
  hyperdxOtlpHttpUrl,
  privateVpmEnabled,
}: Readonly<{
  automaticSetupEnabled?: boolean;
  requestUrl?: string | URL | null;
  siteUrl?: string | null;
  frontendUrl?: string | null;
  buildId?: string | null;
  convexSiteUrl?: string | null;
  convexUrl?: string | null;
  fallback?: string;
  hyperdxApiKey?: string | null;
  hyperdxAppUrl?: string | null;
  hyperdxOtlpHttpUrl?: string | null;
  privateVpmEnabled?: boolean;
}>): PublicRuntimeConfig {
  return {
    automaticSetupEnabled: automaticSetupEnabled === true,
    browserAuthBaseUrl: resolveBrowserAuthBaseUrl({
      requestUrl,
      siteUrl,
      frontendUrl,
      fallback,
    }),
    buildId: normalizeOptionalValue(buildId) ?? 'dev',
    convexSiteUrl: normalizeOptionalValue(convexSiteUrl),
    convexUrl: normalizeOptionalValue(convexUrl),
    hyperdxApiKey: normalizeOptionalValue(hyperdxApiKey),
    hyperdxAppUrl: normalizeOptionalValue(hyperdxAppUrl),
    hyperdxOtlpHttpUrl: normalizeOptionalValue(hyperdxOtlpHttpUrl),
    privateVpmEnabled: privateVpmEnabled === true,
  };
}

export function createPublicRuntimeConfigFromEnv(
  env: PublicRuntimeEnvSource,
  requestUrl?: string | URL | null
): PublicRuntimeConfig {
  const hyperdxOtlpHttpUrl =
    normalizeOptionalValue(env.HYPERDX_OTLP_HTTP_URL) ??
    normalizeOptionalValue(env.OTEL_EXPORTER_OTLP_ENDPOINT);

  return createPublicRuntimeConfig({
    automaticSetupEnabled: isAutomaticSetupEnabled(env as Record<string, string | undefined>),
    buildId: env.BUILD_ID,
    convexSiteUrl: env.CONVEX_SITE_URL,
    convexUrl: env.CONVEX_URL,
    requestUrl,
    frontendUrl: env.FRONTEND_URL,
    hyperdxApiKey: env.HYPERDX_API_KEY,
    hyperdxAppUrl: env.HYPERDX_APP_URL,
    hyperdxOtlpHttpUrl,
    privateVpmEnabled: isPrivateVpmEnabled(env as Record<string, string | undefined>),
    siteUrl: env.SITE_URL,
  });
}

export function pickPublicRuntimeEnvSource(
  env: Record<string, string | null | undefined>
): PublicRuntimeEnvSource {
  return Object.fromEntries(
    PUBLIC_RUNTIME_ENV_KEYS.map((key) => [key, env[key]])
  ) as PublicRuntimeEnvSource;
}

export function buildPublicRuntimeEnvSource(
  readEnv: (key: (typeof PUBLIC_RUNTIME_ENV_KEYS)[number]) => string | undefined
): PublicRuntimeEnvSource {
  return pickPublicRuntimeEnvSource(
    Object.fromEntries(PUBLIC_RUNTIME_ENV_KEYS.map((key) => [key, readEnv(key)]))
  );
}

export function getPublicRuntimeEnvSourceFromProcessEnv(
  env: Record<string, string | null | undefined> = process.env
): PublicRuntimeEnvSource {
  return buildPublicRuntimeEnvSource((key) => normalizeOptionalValue(env[key]));
}

export function getPublicRuntimeConfig(): PublicRuntimeConfig {
  return (
    window.__YUCP_PUBLIC_RUNTIME_CONFIG__ ??
    createPublicRuntimeConfig({
      automaticSetupEnabled: false,
      buildId: 'dev',
      privateVpmEnabled: false,
      requestUrl: window.location.href,
      fallback: window.location.origin,
    })
  );
}

export function serializePublicRuntimeConfig(config: PublicRuntimeConfig): string {
  return JSON.stringify(config)
    .replace(/</g, '\\u003c')
    .replace(/<\/script/gi, '<\\/script');
}

const RuntimeConfigContext = createContext<PublicRuntimeConfig | null>(null);

export function RuntimeConfigProvider({
  children,
  value,
}: Readonly<{ children: ReactNode; value: PublicRuntimeConfig }>) {
  return <RuntimeConfigContext.Provider value={value}>{children}</RuntimeConfigContext.Provider>;
}

export function useRuntimeConfig(): PublicRuntimeConfig {
  const value = useContext(RuntimeConfigContext);
  if (!value) {
    throw new Error('useRuntimeConfig must be used within RuntimeConfigProvider');
  }
  return value;
}
