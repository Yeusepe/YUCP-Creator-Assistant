import { createContext, useContext, type ReactNode } from 'react';

const LOCAL_FALLBACK_SITE_URL = 'http://localhost:3001';

export interface PublicRuntimeConfig {
  browserAuthBaseUrl: string;
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

export function resolveBrowserAuthBaseUrl({
  siteUrl,
  frontendUrl,
  fallback = LOCAL_FALLBACK_SITE_URL,
}: Readonly<{
  siteUrl?: string | null;
  frontendUrl?: string | null;
  fallback?: string;
}>): string {
  return (
    normalizeOrigin(siteUrl) ??
    normalizeOrigin(frontendUrl) ??
    normalizeOrigin(fallback) ??
    LOCAL_FALLBACK_SITE_URL
  );
}

export function getPublicRuntimeConfig(): PublicRuntimeConfig {
  if (import.meta.env.SSR) {
    return {
      browserAuthBaseUrl: resolveBrowserAuthBaseUrl({
        siteUrl: process.env.SITE_URL,
        frontendUrl: process.env.FRONTEND_URL,
      }),
    };
  }

  return (
    window.__YUCP_PUBLIC_RUNTIME_CONFIG__ ?? {
      browserAuthBaseUrl: resolveBrowserAuthBaseUrl({
        frontendUrl: window.location.origin,
        fallback: window.location.origin,
      }),
    }
  );
}

export function serializePublicRuntimeConfig(config: PublicRuntimeConfig): string {
  return JSON.stringify(config).replace(/</g, '\\u003c').replace(/<\/script/gi, '<\\/script');
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
