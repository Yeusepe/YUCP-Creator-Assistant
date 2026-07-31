import HyperDX from '@hyperdx/browser';
import { type Attributes, type Context, context, SpanStatusCode, trace } from '@opentelemetry/api';
import { resolveHyperdxConfig } from '@yucp/shared';
import { authClient } from '@/lib/auth-client';
import {
  PRIVACY_PREFERENCES_EVENT,
  type PrivacyPreferences,
  readStoredPrivacyPreferences,
} from '@/lib/privacyPreferences';
import { getPublicRuntimeConfig } from '@/lib/runtimeConfig';

let initialized = false;
let diagnosticsEnabled = false;
let listenerInstalled = false;
let performanceObservers: PerformanceObserver[] = [];

export interface HyperdxNavigationTimingMetric {
  name: string;
  durationMs: number;
}

export interface HyperdxNavigationSnapshot {
  navigationType: string;
  redirectMs: number;
  dnsMs: number;
  connectionMs: number;
  requestSentMs: number;
  serverWaitMs: number;
  responseDownloadMs: number;
  browserProcessingMs: number;
  domInteractiveMs: number;
  domContentLoadedMs: number;
  loadEventEndMs: number;
  totalMs: number;
  transferSize?: number;
  encodedBodySize?: number;
  decodedBodySize?: number;
  serverTiming: HyperdxNavigationTimingMetric[];
}

export interface HyperdxNavigationPhase {
  name: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

function roundDuration(value: number) {
  return Number(value.toFixed(1));
}

function durationBetween(start: number, end: number) {
  return roundDuration(Math.max(0, end - start));
}

function toBrowserSpanAttributes(
  attributes: Record<string, string | number | boolean | undefined>
): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined)
  ) as Attributes;
}

function getWebHyperdxConfig() {
  const runtimeConfig = getPublicRuntimeConfig();

  return resolveHyperdxConfig({
    NODE_ENV: import.meta.env.MODE,
    FRONTEND_URL: typeof window !== 'undefined' ? window.location.origin : undefined,
    HYPERDX_API_KEY: runtimeConfig.hyperdxApiKey,
    HYPERDX_APP_URL: runtimeConfig.hyperdxAppUrl,
    HYPERDX_OTLP_HTTP_URL: runtimeConfig.hyperdxOtlpHttpUrl,
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
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return redactHyperdxText(serialized);
}

function redactHyperdxText(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|session|password|secret|apiKey|key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(
      /(["'](?:token|session|password|secret|apiKey|key)["']\s*:\s*["'])[^"']+(["'])/gi,
      '$1[REDACTED]$2'
    );
}

function serializeActionAttributes(
  attributes: Record<string, string | number | boolean | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(attributes)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, redactHyperdxText(String(value))])
  );
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
      ignoreUrls: [
        /\/api\/auth\/oauth2\/authorize/,
        /\/api\/verification\/finish\//,
        /[?&](?:token|session|password|secret|apiKey|key|sig|code)=/i,
      ],
      consoleCapture: true,
      advancedNetworkCapture: false,
      blockClass: 'hdx-block',
      maskClass: 'hdx-mask',
      maskAllInputs: true,
      maskAllText: false,
      disableReplay: false,
      otelResourceAttributes: {
        'deployment.environment': import.meta.env.MODE,
        'service.namespace': 'yucp',
        'service.version': getPublicRuntimeConfig().buildId,
        'release.id': getPublicRuntimeConfig().buildId,
      },
    });
    initialized = true;
  }

  if (!initialized) {
    return;
  }

  if (diagnosticsEnabled) {
    HyperDX.resumeSessionRecorder();
    installWebPerformanceObservers();
  } else {
    HyperDX.stopSessionRecorder();
    for (const observer of performanceObservers) {
      observer.disconnect();
    }
    performanceObservers = [];
  }

  const globalAttributes: Record<string, string> = {
    diagnosticsEnabled: diagnosticsEnabled ? 'true' : 'false',
    diagnosticsSessionId: preferences?.diagnosticsSessionId ?? 'none',
  };
  if (!diagnosticsEnabled) {
    globalAttributes.userId = 'none';
  }
  HyperDX.setGlobalAttributes(globalAttributes);
}

function installWebPerformanceObservers() {
  if (typeof PerformanceObserver === 'undefined' || performanceObservers.length > 0) {
    return;
  }

  const observe = (
    type: string,
    action: string,
    readValue: (entries: PerformanceEntryList) => number | undefined
  ) => {
    try {
      const observer = new PerformanceObserver((list) => {
        const value = readValue(list.getEntries());
        if (value !== undefined && Number.isFinite(value)) {
          HyperDX.addAction(action, { valueMs: String(Number(value.toFixed(2))) });
        }
      });
      observer.observe({ type, buffered: true } as PerformanceObserverInit);
      performanceObservers.push(observer);
    } catch {}
  };

  observe(
    'paint',
    'web.performance.fcp',
    (entries) => entries.find((entry) => entry.name === 'first-contentful-paint')?.startTime
  );
  observe(
    'largest-contentful-paint',
    'web.performance.lcp',
    (entries) => entries.at(-1)?.startTime
  );
  observe('layout-shift', 'web.performance.cls', (entries) =>
    entries.reduce(
      (total, entry) => total + Number((entry as PerformanceEntry & { value?: number }).value ?? 0),
      0
    )
  );
  observe('event', 'web.performance.inp', (entries) =>
    entries.reduce((max, entry) => Math.max(max, entry.duration), 0)
  );
}

export function isHyperdxDiagnosticsEnabled() {
  return initialized && diagnosticsEnabled;
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
  if (!isHyperdxDiagnosticsEnabled()) {
    return false;
  }

  const exception = new Error(
    redactHyperdxText(error instanceof Error ? error.message : String(error))
  );
  exception.name = error instanceof Error ? error.name : 'Error';
  if (error instanceof Error && error.stack) {
    exception.stack = redactHyperdxText(error.stack);
  }
  HyperDX.recordException(
    exception,
    Object.fromEntries(
      Object.entries(context).map(([key, value]) => [key, serializeContextValue(value)])
    )
  );
  return true;
}

export function addHyperdxAction(name: string, attributes: Record<string, string> = {}) {
  if (!initialized || !diagnosticsEnabled) {
    return;
  }

  HyperDX.addAction(name, attributes);
}

export function addHyperdxActionWithNumbers(
  name: string,
  attributes: Record<string, string | number | boolean | undefined> = {}
) {
  addHyperdxAction(name, serializeActionAttributes(attributes));
}

export function startHyperdxBrowserSpan(
  name: string,
  attributes: Record<string, string | number | boolean | undefined> = {}
) {
  if (!initialized || !diagnosticsEnabled) {
    return {
      end: (_attributes: Record<string, string | number | boolean | undefined> = {}) => {},
      fail: (
        _error: unknown,
        _attributes: Record<string, string | number | boolean | undefined> = {}
      ) => {},
    };
  }

  const span = trace.getTracer('yucp-web').startSpan(name, {
    attributes: toBrowserSpanAttributes({
      'app.operation.type': 'web.browser.operation',
      'app.operation.name': name,
      ...attributes,
    }),
  });

  return {
    end(extraAttributes: Record<string, string | number | boolean | undefined> = {}) {
      const resolvedAttributes = toBrowserSpanAttributes(extraAttributes);
      if (Object.keys(resolvedAttributes).length > 0) {
        span.setAttributes(resolvedAttributes);
      }
      span.setAttribute('app.operation.outcome', 'success');
      span.end();
    },
    fail(
      error: unknown,
      extraAttributes: Record<string, string | number | boolean | undefined> = {}
    ) {
      const resolvedAttributes = toBrowserSpanAttributes(extraAttributes);
      if (Object.keys(resolvedAttributes).length > 0) {
        span.setAttributes(resolvedAttributes);
      }
      if (error instanceof Error) {
        span.recordException(error);
        span.setAttribute('error.type', error.name);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message,
        });
      }
      span.setAttribute('app.operation.outcome', 'error');
      span.end();
    },
  };
}

export function getHyperdxNavigationSnapshot(): HyperdxNavigationSnapshot | null {
  if (typeof window === 'undefined' || typeof performance === 'undefined') {
    return null;
  }

  const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
  if (!entry) {
    return null;
  }

  const timingEntries = ((entry as PerformanceNavigationTiming & { serverTiming?: unknown })
    .serverTiming ?? []) as ReadonlyArray<{ name?: string; duration?: number }>;

  const responseEnd = entry.responseEnd || entry.responseStart || entry.requestStart;
  const totalMs =
    entry.loadEventEnd > 0
      ? entry.loadEventEnd
      : entry.domContentLoadedEventEnd > 0
        ? entry.domContentLoadedEventEnd
        : entry.duration;

  return {
    navigationType: entry.type,
    redirectMs: durationBetween(entry.redirectStart, entry.redirectEnd),
    dnsMs: durationBetween(entry.domainLookupStart, entry.domainLookupEnd),
    connectionMs: durationBetween(entry.connectStart, entry.connectEnd),
    requestSentMs: durationBetween(entry.connectEnd, entry.requestStart),
    serverWaitMs: durationBetween(entry.requestStart, entry.responseStart),
    responseDownloadMs: durationBetween(entry.responseStart, responseEnd),
    browserProcessingMs: durationBetween(responseEnd, totalMs),
    domInteractiveMs: roundDuration(entry.domInteractive),
    domContentLoadedMs: roundDuration(entry.domContentLoadedEventEnd),
    loadEventEndMs: roundDuration(entry.loadEventEnd || totalMs),
    totalMs: roundDuration(totalMs),
    transferSize: entry.transferSize || undefined,
    encodedBodySize: entry.encodedBodySize || undefined,
    decodedBodySize: entry.decodedBodySize || undefined,
    serverTiming: timingEntries
      .filter(
        (metric): metric is { name: string; duration: number } =>
          typeof metric?.name === 'string' && typeof metric.duration === 'number'
      )
      .map((metric) => ({
        name: metric.name,
        durationMs: roundDuration(metric.duration),
      })),
  };
}

export function buildHyperdxNavigationPhases(
  snapshot: HyperdxNavigationSnapshot
): HyperdxNavigationPhase[] {
  let cursor = 0;
  const phases: HyperdxNavigationPhase[] = [];

  for (const [name, durationMs] of [
    ['redirect', snapshot.redirectMs],
    ['dns', snapshot.dnsMs],
    ['connection', snapshot.connectionMs],
    ['request-sent', snapshot.requestSentMs],
    ['server-wait', snapshot.serverWaitMs],
    ['response-download', snapshot.responseDownloadMs],
    ['browser-processing', snapshot.browserProcessingMs],
  ] as const) {
    if (durationMs <= 0) {
      continue;
    }

    const startMs = roundDuration(cursor);
    const endMs = roundDuration(cursor + durationMs);
    phases.push({ name, startMs, endMs, durationMs });
    cursor = endMs;
  }

  return phases;
}

export function getHyperdxSlowestNavigationPhase(
  phases: HyperdxNavigationPhase[]
): HyperdxNavigationPhase | null {
  if (phases.length === 0) {
    return null;
  }

  return phases.reduce((slowest, candidate) =>
    candidate.durationMs > slowest.durationMs ? candidate : slowest
  );
}

function toAbsoluteTime(relativeMs: number) {
  return performance.timeOrigin + relativeMs;
}

export function recordHyperdxNavigationTrace(
  name: string,
  phases: HyperdxNavigationPhase[],
  attributes: Record<string, string | number | boolean | undefined> = {}
) {
  if (!initialized || !diagnosticsEnabled || typeof performance === 'undefined') {
    return;
  }

  const totalMs = phases.length > 0 ? (phases[phases.length - 1]?.endMs ?? 0) : 0;
  const tracer = trace.getTracer('yucp-web');
  const rootSpan = tracer.startSpan(
    name,
    {
      startTime: toAbsoluteTime(0),
      attributes: toBrowserSpanAttributes({
        'app.operation.type': 'web.navigation',
        'app.operation.name': name,
        ...attributes,
      }),
    },
    context.active()
  );
  const parentContext: Context = trace.setSpan(context.active(), rootSpan);

  for (const phase of phases) {
    const span = tracer.startSpan(
      `${name}.${phase.name}`,
      {
        startTime: toAbsoluteTime(phase.startMs),
        attributes: toBrowserSpanAttributes({
          'app.operation.type': 'web.navigation.phase',
          'app.operation.name': `${name}.${phase.name}`,
          ...attributes,
          phase: phase.name,
          durationMs: phase.durationMs,
        }),
      },
      parentContext
    );
    span.end(toAbsoluteTime(phase.endMs));
  }

  rootSpan.setAttribute('app.operation.outcome', 'success');
  rootSpan.end(toAbsoluteTime(totalMs));
}

export function setHyperdxGlobalAttributes(
  attributes: Record<string, string | number | boolean | undefined>
) {
  if (!initialized || !diagnosticsEnabled) {
    return;
  }

  HyperDX.setGlobalAttributes(serializeActionAttributes(attributes));
}
