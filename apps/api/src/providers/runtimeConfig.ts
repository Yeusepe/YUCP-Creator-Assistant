import { loadEnv } from '../lib/env';

export interface JinxxyProviderRuntimeConfig {
  apiBaseUrl?: string;
}

export function getJinxxyProviderRuntimeConfig(): JinxxyProviderRuntimeConfig {
  const env = loadEnv();

  return {
    apiBaseUrl: env.JINXXY_API_BASE_URL,
  };
}
