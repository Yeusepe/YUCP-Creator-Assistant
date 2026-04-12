const LOCAL_HYPERDX_APP_URL = 'http://localhost:8080';
const LOCAL_HYPERDX_OTLP_HTTP_URL = 'http://localhost:4318';
const LOCAL_HYPERDX_OTLP_GRPC_URL = 'localhost:4317';

export type ServerObservabilityRuntime = 'node-hyperdx' | 'bun-manual';
export type OtlpSignal = 'traces' | 'logs' | 'metrics';

export interface RuntimeEnvironmentLike {
  Bun?: {
    version?: string;
  };
}

export interface HyperdxEnvLike {
  NODE_ENV?: string;
  FRONTEND_URL?: string;
  SITE_URL?: string;
  HYPERDX_API_KEY?: string;
  HYPERDX_APP_URL?: string;
  HYPERDX_OTLP_HTTP_URL?: string;
  HYPERDX_OTLP_GRPC_URL?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  OTEL_EXPORTER_OTLP_PROTOCOL?: string;
  OTEL_SERVICE_NAME?: string;
  HDX_NODE_BETA_MODE?: string;
}

export interface ResolvedHyperdxConfig {
  apiKey?: string;
  otelExporterHeaders?: string;
  hasOtelAuth: boolean;
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

export function detectServerObservabilityRuntime(
  runtimeEnvironment: RuntimeEnvironmentLike = globalThis as RuntimeEnvironmentLike
): ServerObservabilityRuntime {
  return runtimeEnvironment.Bun ? 'bun-manual' : 'node-hyperdx';
}

export function buildOtlpSignalUrl(endpoint: string, signal: OtlpSignal): string {
  const normalizedEndpoint = endpoint.trim().replace(/\/+$/, '');
  const signalPath = `/v1/${signal}`;
  return normalizedEndpoint.endsWith(signalPath)
    ? normalizedEndpoint
    : `${normalizedEndpoint}${signalPath}`;
}

export function parseOtelExporterHeaders(
  headers: string | undefined
): Record<string, string> | undefined {
  const normalizedHeaders = normalizeOptional(headers);
  if (!normalizedHeaders) {
    return undefined;
  }

  const entries = normalizedHeaders
    .split(',')
    .map((part) => {
      const [key, ...valueParts] = part.split('=');
      const normalizedKey = key?.trim();
      const normalizedValue = valueParts.join('=').trim();
      if (!normalizedKey || !normalizedValue) {
        return null;
      }
      return [normalizedKey, normalizedValue] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function resolveHyperdxApiKey(env: HyperdxEnvLike): string | undefined {
  return normalizeOptional(env.HYPERDX_API_KEY);
}

function resolveOtelExporterHeaders(
  env: HyperdxEnvLike,
  apiKey: string | undefined
): string | undefined {
  const explicitHeaders = normalizeOptional(env.OTEL_EXPORTER_OTLP_HEADERS);
  if (!apiKey) {
    return explicitHeaders;
  }

  if (!explicitHeaders) {
    return `Authorization=${apiKey}`;
  }

  if (/(^|,)\s*Authorization\s*=/.test(explicitHeaders)) {
    return explicitHeaders;
  }

  return `${explicitHeaders},Authorization=${apiKey}`;
}

export function resolveHyperdxConfig(env: HyperdxEnvLike): ResolvedHyperdxConfig {
  const apiKey = resolveHyperdxApiKey(env);
  const otelExporterHeaders = resolveOtelExporterHeaders(env, apiKey);
  const appUrl = normalizeOptional(env.HYPERDX_APP_URL) ?? LOCAL_HYPERDX_APP_URL;
  const otlpHttpUrl =
    normalizeOptional(env.HYPERDX_OTLP_HTTP_URL) ??
    normalizeOptional(env.OTEL_EXPORTER_OTLP_ENDPOINT) ??
    LOCAL_HYPERDX_OTLP_HTTP_URL;
  const otlpGrpcUrl = normalizeOptional(env.HYPERDX_OTLP_GRPC_URL) ?? LOCAL_HYPERDX_OTLP_GRPC_URL;

  return {
    apiKey,
    otelExporterHeaders,
    hasOtelAuth: Boolean(otelExporterHeaders),
    appUrl,
    otlpHttpUrl,
    otlpGrpcUrl,
    otelExporterEndpoint: otlpHttpUrl,
    otelExporterProtocol: normalizeOptional(env.OTEL_EXPORTER_OTLP_PROTOCOL) ?? 'http/protobuf',
  };
}

export function applyNodeHyperdxDefaults(
  env: NodeJS.ProcessEnv,
  serviceName: string
): ResolvedHyperdxConfig {
  const resolved = resolveHyperdxConfig(env);

  if (resolved.apiKey && !normalizeOptional(env.HYPERDX_API_KEY)) {
    env.HYPERDX_API_KEY = resolved.apiKey;
  }

  env.HYPERDX_APP_URL ??= resolved.appUrl;
  env.HYPERDX_OTLP_HTTP_URL ??= resolved.otlpHttpUrl;
  env.HYPERDX_OTLP_GRPC_URL ??= resolved.otlpGrpcUrl;
  env.OTEL_EXPORTER_OTLP_ENDPOINT ??= resolved.otelExporterEndpoint;
  if (resolved.otelExporterHeaders && !normalizeOptional(env.OTEL_EXPORTER_OTLP_HEADERS)) {
    env.OTEL_EXPORTER_OTLP_HEADERS = resolved.otelExporterHeaders;
  }
  env.OTEL_EXPORTER_OTLP_PROTOCOL ??= resolved.otelExporterProtocol;
  env.OTEL_SERVICE_NAME ??= serviceName;
  env.HDX_NODE_BETA_MODE ??= '1';

  return resolved;
}
