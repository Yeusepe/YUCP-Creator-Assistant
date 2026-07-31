import { captureHyperdxException, isHyperdxDiagnosticsEnabled } from '@/lib/hyperdx';
import { getPublicRuntimeConfig } from '@/lib/runtimeConfig';

export interface WebDiagnosticsEnv {
  NODE_ENV?: string;
  CONVEX_URL?: string;
  CONVEX_SITE_URL?: string;
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  ALL_PROXY?: string;
  NO_PROXY?: string;
  NODE_TLS_REJECT_UNAUTHORIZED?: string;
}

export interface LocationLike {
  pathname?: string | undefined;
}

export interface ServerAuthClientLike {
  serverHttpClient?: {
    setAuth(token: string): void;
  } | null;
}

export interface LoadProtectedAuthStateOptions {
  convexQueryClient: ServerAuthClientLike;
  location?: LocationLike | null;
  getAuthSession?: () => Promise<{ isAuthenticated: boolean } | null | undefined>;
  getAuthToken?: () => Promise<string | null | undefined>;
  env?: WebDiagnosticsEnv;
}

export interface RootRenderLogOptions {
  route?: string | undefined;
  env?: WebDiagnosticsEnv;
}

export interface ProtectedAuthState {
  isAuthenticated: boolean;
  token: string | null;
}

const loggedRootErrors = new WeakSet<Error>();
const loggedErrorObjects = new WeakSet<Error>();
const loggedGlobalErrors = new Set<string>();
let globalErrorHandlersInstalled = false;

const OPERATIONAL_ERROR_MAX_BYTES = 12_000;
const SAFE_OPERATIONAL_CONTEXT_KEYS = new Set([
  'column',
  'durationMs',
  'line',
  'method',
  'networkFailure',
  'operation',
  'phase',
  'reason',
  'route',
  'routeCategory',
  'source',
  'stage',
  'status',
]);

function getDefaultEnv(): WebDiagnosticsEnv {
  const processEnv = typeof process !== 'undefined' ? process.env : undefined;
  const publicRuntimeConfig = typeof window !== 'undefined' ? getPublicRuntimeConfig() : undefined;

  return {
    NODE_ENV: import.meta.env.MODE ?? processEnv?.NODE_ENV,
    CONVEX_URL: publicRuntimeConfig?.convexUrl ?? processEnv?.CONVEX_URL,
    CONVEX_SITE_URL: publicRuntimeConfig?.convexSiteUrl ?? processEnv?.CONVEX_SITE_URL,
    HTTP_PROXY: processEnv?.HTTP_PROXY,
    HTTPS_PROXY: processEnv?.HTTPS_PROXY,
    ALL_PROXY: processEnv?.ALL_PROXY,
    NO_PROXY: processEnv?.NO_PROXY,
    NODE_TLS_REJECT_UNAUTHORIZED: processEnv?.NODE_TLS_REJECT_UNAUTHORIZED,
  };
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|session|password|secret|apiKey|key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(
      /(["'](?:token|session|password|secret|apiKey|key)["']\s*:\s*["'])[^"']+(["'])/gi,
      '$1[REDACTED]$2'
    );
}

function safeHost(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function buildEnvSnapshot(env: WebDiagnosticsEnv): Record<string, unknown> {
  return compactRecord({
    nodeEnv: env.NODE_ENV,
    hasConvexUrl: Boolean(env.CONVEX_URL),
    convexUrlHost: safeHost(env.CONVEX_URL),
    hasConvexSiteUrl: Boolean(env.CONVEX_SITE_URL),
    convexSiteUrlHost: safeHost(env.CONVEX_SITE_URL),
    hasHttpProxy: Boolean(env.HTTP_PROXY),
    hasHttpsProxy: Boolean(env.HTTPS_PROXY),
    hasAllProxy: Boolean(env.ALL_PROXY),
    hasNoProxy: Boolean(env.NO_PROXY),
    nodeTlsRejectUnauthorized: env.NODE_TLS_REJECT_UNAUTHORIZED,
  });
}

function getNetworkHint(error: unknown, env: WebDiagnosticsEnv): string | undefined {
  const message = error instanceof Error ? error.message : String(error);

  if (!message.includes('Unable to connect. Is the computer able to access the url?')) {
    return undefined;
  }

  if (env.HTTPS_PROXY) {
    return 'HTTPS_PROXY is set for the web runtime';
  }

  if (env.HTTP_PROXY) {
    return 'HTTP_PROXY is set for the web runtime';
  }

  if (env.ALL_PROXY) {
    return 'ALL_PROXY is set for the web runtime';
  }

  return undefined;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const errorWithCause = error as Error & { cause?: unknown };

    return compactRecord({
      name: error.name,
      message: redactSensitiveText(error.message),
      stack: error.stack ? redactSensitiveText(error.stack) : undefined,
      cause:
        errorWithCause.cause instanceof Error
          ? compactRecord({
              name: errorWithCause.cause.name,
              message: redactSensitiveText(errorWithCause.cause.message),
            })
          : undefined,
    });
  }

  if (typeof error === 'string') {
    return { message: redactSensitiveText(error) };
  }

  return { value: redactSensitiveText(String(error)) };
}

function buildOperationalErrorPayload(
  event: string,
  error: unknown,
  context: Record<string, unknown>
) {
  const runtimeConfig = typeof window !== 'undefined' ? getPublicRuntimeConfig() : null;
  const safeContext = Object.fromEntries(
    Object.entries(context)
      .filter(([key]) => SAFE_OPERATIONAL_CONTEXT_KEYS.has(key))
      .map(([key, value]) => {
        if (typeof value === 'string') {
          return [key, redactSensitiveText(value).slice(0, 240)];
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
          return [key, value];
        }
        return [key, undefined];
      })
      .filter(([, value]) => value !== undefined)
  );

  return {
    event: redactSensitiveText(event).slice(0, 160),
    error: serializeError(error),
    context: compactRecord(safeContext),
    route: typeof window !== 'undefined' ? window.location.pathname : undefined,
    release: runtimeConfig?.buildId,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 240) : undefined,
  };
}

export function reportOperationalWebError(
  event: string,
  error: unknown,
  context: Record<string, unknown> = {}
): void {
  if (typeof window === 'undefined' || isHyperdxDiagnosticsEnabled()) {
    return;
  }

  const payload = JSON.stringify(buildOperationalErrorPayload(event, error, context));
  if (new TextEncoder().encode(payload).byteLength > OPERATIONAL_ERROR_MAX_BYTES) {
    return;
  }

  const body = new Blob([payload], { type: 'application/json' });
  if (
    typeof navigator.sendBeacon === 'function' &&
    navigator.sendBeacon('/api/telemetry/browser-error', body)
  ) {
    return;
  }

  void Promise.resolve()
    .then(() =>
      fetch('/api/telemetry/browser-error', {
        method: 'POST',
        body: payload,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        keepalive: true,
      })
    )
    .catch(() => undefined);
}

export function logWebError(
  event: string,
  error: unknown,
  context: Record<string, unknown> = {}
): void {
  if (error instanceof Error) {
    if (loggedErrorObjects.has(error)) {
      return;
    }
    loggedErrorObjects.add(error);
  }

  const captured = captureHyperdxException(error, {
    event,
    ...context,
  });
  if (!captured) {
    reportOperationalWebError(event, error, context);
  }
  console.error(`[web] ${event}`, compactRecord({ ...context, error: serializeError(error) }));
}

function getGlobalErrorKey(event: string, error: unknown) {
  const serialized = serializeError(error);
  return `${event}:${serialized.name ?? 'Error'}:${serialized.message ?? 'unknown'}`;
}

export function installGlobalWebErrorHandlers(): void {
  if (typeof window === 'undefined' || globalErrorHandlersInstalled) {
    return;
  }

  globalErrorHandlersInstalled = true;
  window.addEventListener('error', (event) => {
    const error = event.error ?? new Error(event.message || 'Unhandled browser error');
    const key = getGlobalErrorKey('Unhandled browser exception', error);
    if (loggedGlobalErrors.has(key)) {
      return;
    }
    loggedGlobalErrors.add(key);
    logWebError('Unhandled browser exception', error, {
      source: event.filename ? new URL(event.filename, window.location.origin).pathname : undefined,
      line: event.lineno || undefined,
      column: event.colno || undefined,
      phase: 'window.error',
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    const key = getGlobalErrorKey('Unhandled promise rejection', error);
    if (loggedGlobalErrors.has(key)) {
      return;
    }
    loggedGlobalErrors.add(key);
    logWebError('Unhandled promise rejection', error, { phase: 'window.unhandledrejection' });
  });
}

export async function loadProtectedAuthState({
  convexQueryClient,
  location,
  getAuthSession,
  getAuthToken,
  env = getDefaultEnv(),
}: LoadProtectedAuthStateOptions): Promise<ProtectedAuthState> {
  try {
    const session = getAuthSession ? await getAuthSession() : null;
    if (session?.isAuthenticated) {
      return {
        isAuthenticated: true,
        token: null,
      };
    }

    if (session && !session.isAuthenticated) {
      return {
        isAuthenticated: false,
        token: null,
      };
    }

    const token = getAuthToken ? ((await getAuthToken()) ?? null) : null;

    if (token) {
      convexQueryClient.serverHttpClient?.setAuth(token);
    }

    return {
      isAuthenticated: token !== null,
      token,
    };
  } catch (error) {
    logWebError(
      'Protected auth bootstrap failed',
      error,
      compactRecord({
        phase: 'protected-beforeLoad',
        route: location?.pathname,
        networkHint: getNetworkHint(error, env),
        ...buildEnvSnapshot(env),
      })
    );

    throw error;
  }
}

export function logRootRenderError(
  error: Error,
  { route, env = getDefaultEnv() }: RootRenderLogOptions = {}
): void {
  if (loggedRootErrors.has(error)) {
    return;
  }

  loggedRootErrors.add(error);

  logWebError(
    'Root render error',
    error,
    compactRecord({
      phase: 'root-error-boundary',
      route,
      ...buildEnvSnapshot(env),
    })
  );
}

export function resolveRequiredConvexUrl(
  convexUrl: string | undefined,
  { env = getDefaultEnv() }: { env?: WebDiagnosticsEnv } = {}
): string {
  const normalizedConvexUrl = convexUrl?.trim();

  if (normalizedConvexUrl) {
    return normalizedConvexUrl;
  }

  const error = new Error(
    'CONVEX_URL is not available. Ensure it is set in your Infisical environment.'
  );

  logWebError(
    'Router initialization failed',
    error,
    compactRecord({
      phase: 'router-init',
      ...buildEnvSnapshot({
        ...env,
        CONVEX_URL: normalizedConvexUrl,
      }),
    })
  );

  throw error;
}
