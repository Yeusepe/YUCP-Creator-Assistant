import { loadEnv } from '../lib/env';

export interface GumroadProviderRuntimeConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface JinxxyProviderRuntimeConfig {
  apiBaseUrl?: string;
}

export function getGumroadProviderRuntimeConfig(): GumroadProviderRuntimeConfig {
  const env = loadEnv();

  return {
    clientId: env.GUMROAD_CLIENT_ID ?? '',
    clientSecret: env.GUMROAD_CLIENT_SECRET ?? '',
    redirectUri: '',
  };
}

export function getJinxxyProviderRuntimeConfig(): JinxxyProviderRuntimeConfig {
  const env = loadEnv();

  return {
    apiBaseUrl: env.JINXXY_API_BASE_URL,
  };
}
