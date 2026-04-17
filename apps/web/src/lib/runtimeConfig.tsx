import { createContext, type ReactNode, useContext } from 'react';

const LOCAL_FALLBACK_SITE_URL = 'http://localhost:3000';

export interface PublicRuntimeConfig {
  browserAuthBaseUrl: string;
  buildId: string;
  convexSiteUrl?: string;
  convexUrl?: string;
  hyperdxApiKey?: string;
  hyperdxAppUrl?: string;
  hyperdxOtlpHttpUrl?: string;
}

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
}: Readonly<{
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
}>): PublicRuntimeConfig {
  return {
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
  };
}

export function getPublicRuntimeConfig(): PublicRuntimeConfig {
  return (
    window.__YUCP_PUBLIC_RUNTIME_CONFIG__ ??
    createPublicRuntimeConfig({
      buildId: 'dev',
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
