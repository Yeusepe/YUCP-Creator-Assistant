import HyperDX from '@hyperdx/browser';
import { resolveHyperdxConfig } from '@yucp/shared';
import { authClient } from '@/lib/auth-client';
import {
  PRIVACY_PREFERENCES_EVENT,
  type PrivacyPreferences,
  readStoredPrivacyPreferences,
} from '@/lib/privacyPreferences';

let initialized = false;
let diagnosticsEnabled = false;
let listenerInstalled = false;

function getWebHyperdxConfig() {
  return resolveHyperdxConfig({
    NODE_ENV: import.meta.env.MODE,
    FRONTEND_URL: typeof window !== 'undefined' ? window.location.origin : undefined,
    HYPERDX_API_KEY: import.meta.env.HYPERDX_API_KEY as string | undefined,
    HYPERDX_APP_URL: import.meta.env.HYPERDX_APP_URL as string | undefined,
    HYPERDX_OTLP_HTTP_URL: import.meta.env.HYPERDX_OTLP_HTTP_URL as string | undefined,
  });
}

function buildTraceTargets(): RegExp[] {
  if (typeof window === 'undefined') {
    return [/^\/api\//i];
  }

  const escapedOrigin = window.location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [/^\/api\//i, new RegExp(`^${escapedOrigin}/api/`, 'i')];
}

function serializeContextValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value);
}

function applyDiagnosticsPreference(preferences: PrivacyPreferences | null) {
  diagnosticsEnabled = Boolean(preferences?.diagnosticsEnabled);

  if (!initialized && diagnosticsEnabled) {
    const config = getWebHyperdxConfig();
    if (!config.apiKey) {
      console.warn(
        '[hyperdx] Helpful diagnostics are enabled, but HYPERDX_API_KEY is missing. Create an ingest key in HyperDX and add it to Infisical before expecting telemetry ingestion.'
      );
      return;
    }

    HyperDX.init({
      apiKey: config.apiKey,
      service: 'yucp-web',
      url: config.otlpHttpUrl,
      tracePropagationTargets: buildTraceTargets(),
      consoleCapture: true,
      advancedNetworkCapture: false,
      maskAllInputs: true,
      maskAllText: false,
      disableReplay: false,
      otelResourceAttributes: {
        'deployment.environment': import.meta.env.MODE,
        'service.namespace': 'yucp',
        'service.version':
          (import.meta as { env?: { VITE_BUILD_ID?: string } }).env?.VITE_BUILD_ID ?? 'dev',
      },
    });
    initialized = true;
  }

  if (!initialized) {
    return;
  }

  if (diagnosticsEnabled) {
    HyperDX.resumeSessionRecorder();
    HyperDX.enableAdvancedNetworkCapture();
  } else {
    HyperDX.stopSessionRecorder();
    HyperDX.disableAdvancedNetworkCapture();
  }

  HyperDX.setGlobalAttributes({
    diagnosticsEnabled: diagnosticsEnabled ? 'true' : 'false',
    diagnosticsSessionId: preferences?.diagnosticsSessionId ?? 'none',
  });
}

async function syncAuthenticatedUser() {
  if (!initialized || !diagnosticsEnabled) {
    return;
  }

  const session = await authClient.getSession().catch(() => null);
  const authUserId = session?.data?.user?.id;
  if (typeof authUserId === 'string' && authUserId.trim()) {
    HyperDX.setGlobalAttributes({
      userId: authUserId,
    });
  }
}

export function initializeHyperdxBrowser() {
  if (typeof window === 'undefined') {
    return;
  }

  applyDiagnosticsPreference(readStoredPrivacyPreferences());
  void syncAuthenticatedUser();

  if (listenerInstalled) {
    return;
  }

  listenerInstalled = true;
  window.addEventListener(PRIVACY_PREFERENCES_EVENT, (event) => {
    const detail =
      event instanceof CustomEvent ? (event.detail as PrivacyPreferences | null) : null;
    applyDiagnosticsPreference(detail ?? readStoredPrivacyPreferences());
    void syncAuthenticatedUser();
  });
}

export function captureHyperdxException(error: unknown, context: Record<string, unknown> = {}) {
  if (!initialized || !diagnosticsEnabled) {
    return;
  }

  const exception = error instanceof Error ? error : new Error(String(error));
  HyperDX.recordException(
    exception,
    Object.fromEntries(
      Object.entries(context).map(([key, value]) => [key, serializeContextValue(value)])
    )
  );
}

export function addHyperdxAction(name: string, attributes: Record<string, string> = {}) {
  if (!initialized || !diagnosticsEnabled) {
    return;
  }

  HyperDX.addAction(name, attributes);
}
