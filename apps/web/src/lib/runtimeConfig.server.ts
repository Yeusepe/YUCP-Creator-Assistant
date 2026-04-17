import { getRequestUrl } from '@tanstack/react-start/server';
import {
  buildPublicRuntimeEnvSource,
  createPublicRuntimeConfigFromEnv,
  type PublicRuntimeConfig,
  type PublicRuntimeEnvSource,
} from '@/lib/runtimeConfig';
import { getWebEnv, getWebRuntimeEnv } from '@/lib/server/runtimeEnv';

export function getPublicRuntimeEnvSource(env = getWebRuntimeEnv()): PublicRuntimeEnvSource {
  return buildPublicRuntimeEnvSource((key) => getWebEnv(key, env));
}

export function getPublicRuntimeConfigForRequest(): PublicRuntimeConfig {
  const requestUrl = getRequestUrl({
    xForwardedHost: true,
    xForwardedProto: true,
  }).toString();

  return createPublicRuntimeConfigFromEnv(getPublicRuntimeEnvSource(), requestUrl);
}
