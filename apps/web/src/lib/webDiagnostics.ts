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

export interface LoadRootAuthStateOptions {
  convexQueryClient: ServerAuthClientLike;
  location?: LocationLike | null;
  getAuthToken: () => Promise<string | null | undefined>;
  env?: WebDiagnosticsEnv;
}

export interface RootRenderLogOptions {
  route?: string | undefined;
  env?: WebDiagnosticsEnv;
}

export interface RootAuthState {
  isAuthenticated: boolean;
  token: string | null;
}

const loggedRootErrors = new WeakSet<Error>();

function getDefaultEnv(): WebDiagnosticsEnv {
  const processEnv = typeof process !== 'undefined' ? process.env : undefined;

  return {
    NODE_ENV: import.meta.env.MODE ?? processEnv?.NODE_ENV,
    CONVEX_URL: (import.meta.env.CONVEX_URL as string | undefined) ?? processEnv?.CONVEX_URL,
    CONVEX_SITE_URL:
      (import.meta.env.CONVEX_SITE_URL as string | undefined) ?? processEnv?.CONVEX_SITE_URL,
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

export function logWebError(
  event: string,
  error: unknown,
  context: Record<string, unknown> = {}
): void {
  console.error(`[web] ${event}`, compactRecord({ ...context, error: serializeError(error) }));
}

export async function loadRootAuthState({
  convexQueryClient,
  location,
  getAuthToken,
  env = getDefaultEnv(),
}: LoadRootAuthStateOptions): Promise<RootAuthState> {
  try {
    const token = (await getAuthToken()) ?? null;

    if (token) {
      convexQueryClient.serverHttpClient?.setAuth(token);
    }

    return {
      isAuthenticated: token !== null,
      token,
    };
  } catch (error) {
    logWebError(
      'Root auth bootstrap failed',
      error,
      compactRecord({
        phase: 'root-beforeLoad',
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
