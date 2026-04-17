export type WebRuntimeEnv = NodeJS.ProcessEnv & {
  /** When true, treated like `NODE_ENV=production` for strict runtime checks (e.g. API base URL). */
  isProduction?: boolean;
};

const isCloudflareWorkerRuntime = 'WebSocketPair' in globalThis && !('Bun' in globalThis);
const workerRuntimeInstanceId = isCloudflareWorkerRuntime
  ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  : null;

if (workerRuntimeInstanceId) {
  console.info(`[yucp/web] Worker runtime started (${workerRuntimeInstanceId})`);
}

if (import.meta.hot && workerRuntimeInstanceId) {
  import.meta.hot.dispose(() => {
    console.info(`[yucp/web] Worker runtime disposed (${workerRuntimeInstanceId})`);
  });
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function getWebRuntimeEnv(env: WebRuntimeEnv = process.env): WebRuntimeEnv {
  return env;
}

export function getWebEnv(
  name: string,
  env: WebRuntimeEnv = getWebRuntimeEnv()
): string | undefined {
  return normalizeOptional(env[name]);
}

export function isWebProductionRuntime(env: WebRuntimeEnv = getWebRuntimeEnv()): boolean {
  return env.isProduction === true || getWebEnv('NODE_ENV', env) === 'production';
}

export function getWebApiBaseUrl(env: WebRuntimeEnv = getWebRuntimeEnv()): string {
  const api = getWebEnv('API_BASE_URL', env);
  if (api) {
    return api;
  }

  const isProduction = isWebProductionRuntime(env) || env.isProduction === true;
  if (isProduction) {
    throw new Error(
      'API_BASE_URL is required in production. Set it to the origin of the Bun API (for example https://api.example.com).'
    );
  }

  console.warn(
    '[yucp/web] API_BASE_URL is not set; using default http://localhost:3001 for non-production runtime.'
  );
  return 'http://localhost:3001';
}
