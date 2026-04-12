const LOCAL_HYPERDX_API_KEY = 'local';
const LOCAL_HYPERDX_APP_URL = 'http://localhost:8080';
const LOCAL_HYPERDX_OTLP_HTTP_URL = 'http://localhost:4318';
const LOCAL_HYPERDX_OTLP_GRPC_URL = 'localhost:4317';

export interface HyperdxEnvLike {
  NODE_ENV?: string;
  FRONTEND_URL?: string;
  SITE_URL?: string;
  HYPERDX_API_KEY?: string;
  HYPERDX_APP_URL?: string;
  HYPERDX_OTLP_HTTP_URL?: string;
  HYPERDX_OTLP_GRPC_URL?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_PROTOCOL?: string;
  OTEL_SERVICE_NAME?: string;
  HDX_NODE_BETA_MODE?: string;
}

export interface ResolvedHyperdxConfig {
  apiKey?: string;
  appUrl: string;
  otlpHttpUrl: string;
  otlpGrpcUrl: string;
  otelExporterEndpoint: string;
  otelExporterProtocol: string;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isLocalOrigin(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    const host = new URL(value).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

export function resolveHyperdxApiKey(
  env: HyperdxEnvLike,
  { allowLocalFallback = false }: { allowLocalFallback?: boolean } = {}
): string | undefined {
  const explicit = normalizeOptional(env.HYPERDX_API_KEY);
  if (explicit) {
    return explicit;
  }

  if (!allowLocalFallback) {
    return undefined;
  }

  if ((env.NODE_ENV ?? 'development') === 'production') {
    return undefined;
  }

  const localEndpoint =
    isLocalOrigin(normalizeOptional(env.HYPERDX_APP_URL)) ||
    isLocalOrigin(normalizeOptional(env.HYPERDX_OTLP_HTTP_URL)) ||
    isLocalOrigin(normalizeOptional(env.OTEL_EXPORTER_OTLP_ENDPOINT)) ||
    isLocalOrigin(normalizeOptional(env.FRONTEND_URL)) ||
    isLocalOrigin(normalizeOptional(env.SITE_URL));

  return localEndpoint ? LOCAL_HYPERDX_API_KEY : undefined;
}

export function resolveHyperdxConfig(
  env: HyperdxEnvLike,
  { allowLocalFallbackApiKey = false }: { allowLocalFallbackApiKey?: boolean } = {}
): ResolvedHyperdxConfig {
  const appUrl = normalizeOptional(env.HYPERDX_APP_URL) ?? LOCAL_HYPERDX_APP_URL;
  const otlpHttpUrl =
    normalizeOptional(env.HYPERDX_OTLP_HTTP_URL) ??
    normalizeOptional(env.OTEL_EXPORTER_OTLP_ENDPOINT) ??
    LOCAL_HYPERDX_OTLP_HTTP_URL;
  const otlpGrpcUrl = normalizeOptional(env.HYPERDX_OTLP_GRPC_URL) ?? LOCAL_HYPERDX_OTLP_GRPC_URL;

  return {
    apiKey: resolveHyperdxApiKey(env, { allowLocalFallback: allowLocalFallbackApiKey }),
    appUrl,
    otlpHttpUrl,
    otlpGrpcUrl,
    otelExporterEndpoint: otlpHttpUrl,
    otelExporterProtocol: normalizeOptional(env.OTEL_EXPORTER_OTLP_PROTOCOL) ?? 'http/protobuf',
  };
}

export function applyNodeHyperdxDefaults(
  env: NodeJS.ProcessEnv,
  serviceName: string,
  options: {
    allowLocalFallbackApiKey?: boolean;
  } = {}
): ResolvedHyperdxConfig {
  const resolved = resolveHyperdxConfig(env, {
    allowLocalFallbackApiKey: options.allowLocalFallbackApiKey ?? true,
  });

  if (resolved.apiKey && !normalizeOptional(env.HYPERDX_API_KEY)) {
    env.HYPERDX_API_KEY = resolved.apiKey;
  }

  env.HYPERDX_APP_URL ??= resolved.appUrl;
  env.HYPERDX_OTLP_HTTP_URL ??= resolved.otlpHttpUrl;
  env.HYPERDX_OTLP_GRPC_URL ??= resolved.otlpGrpcUrl;
  env.OTEL_EXPORTER_OTLP_ENDPOINT ??= resolved.otelExporterEndpoint;
  env.OTEL_EXPORTER_OTLP_PROTOCOL ??= resolved.otelExporterProtocol;
  env.OTEL_SERVICE_NAME ??= serviceName;
  env.HDX_NODE_BETA_MODE ??= '1';

  return resolved;
}
