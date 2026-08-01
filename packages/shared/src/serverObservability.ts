import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  applyNodeHyperdxDefaults,
  buildOtlpSignalUrl,
  parseOtelExporterHeaders,
  type ResolvedHyperdxConfig,
} from './hyperdx';
import { redactString } from './logging/redaction';
import { toSpanAttributes } from './observability';

type ResourceAttributeValue = string | number | boolean | undefined;

export interface BunServerObservabilityOptions {
  env?: NodeJS.ProcessEnv;
  serviceName: string;
  resourceAttributes?: Record<string, ResourceAttributeValue>;
  /**
   * Forward structured console output to OTLP as log records. The manual Bun provider installs no
   * console instrumentation, so services that report progress and failures as
   * `console.info(JSON.stringify(...))` are otherwise invisible to the collector no matter how
   * correctly they are configured.
   */
  captureConsole?: boolean;
}

let bunProvider: BasicTracerProvider | null = null;
let bunProviderServiceName: string | null = null;
let shutdownHooksRegistered = false;
let processErrorHandlersInstalled = false;
let consoleBridgeInstalled = false;

const CONSOLE_SEVERITY = {
  debug: 'DEBUG',
  error: 'ERROR',
  info: 'INFO',
  warn: 'WARN',
} as const;

type ConsoleLevel = keyof typeof CONSOLE_SEVERITY;

function attributeValue(value: unknown): string | number | boolean | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  return redactString(JSON.stringify(value) ?? String(value));
}

/**
 * Structured events carry their own shape; lifting the fields to attributes is what makes them
 * filterable rather than a wall of text. Unstructured output still ships, just as a plain body.
 */
export function consoleLogRecord(
  level: ConsoleLevel,
  args: readonly unknown[],
  serviceName: string
): { attributes: Record<string, string | number | boolean>; body: string; severityText: string } {
  const attributes: Record<string, string | number | boolean> = {
    'service.name': serviceName,
    'log.source': 'console',
  };
  let body: string | undefined;

  if (args.length === 1 && typeof args[0] === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args[0]);
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const attribute = attributeValue(value);
        if (attribute !== undefined) {
          attributes[key] = attribute;
        }
      }
      const event = (parsed as { event?: unknown }).event;
      body = typeof event === 'string' ? event : redactString(args[0]);
    }
  }

  return {
    attributes,
    body: body ?? redactString(args.map((arg) => attributeValue(arg) ?? '').join(' ')).trim(),
    severityText: CONSOLE_SEVERITY[level],
  };
}

function installConsoleBridge(serviceName: string) {
  if (consoleBridgeInstalled || typeof console === 'undefined') {
    return;
  }
  consoleBridgeInstalled = true;
  const logger = logs.getLogger(serviceName);

  for (const level of Object.keys(CONSOLE_SEVERITY) as ConsoleLevel[]) {
    const original = console[level]?.bind(console);
    if (!original) {
      continue;
    }
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        logger.emit(consoleLogRecord(level, args, serviceName));
      } catch {
        // Telemetry must never be the reason a service loses its own log line.
      }
    };
  }
}

function reportProcessError(serviceName: string, event: string, error: unknown) {
  const exception = error instanceof Error ? error : new Error(String(error));
  const logger = logs.getLogger(serviceName);
  logger.emit({
    severityText: 'ERROR',
    body: redactString(exception.message),
    attributes: {
      'service.name': serviceName,
      'event.name': 'exception',
      'error.type': exception.name,
      'error.message': redactString(exception.message),
      'error.event': event,
      'exception.type': exception.name,
      'exception.message': redactString(exception.message),
      ...(exception.stack
        ? {
            'error.stack': redactString(exception.stack),
            'exception.stacktrace': redactString(exception.stack),
          }
        : {}),
    },
  });
  console.error(`[${serviceName}] ${event}`, redactString(exception.message));
}

function installProcessErrorHandlers(serviceName: string) {
  if (processErrorHandlersInstalled || typeof process === 'undefined') {
    return;
  }

  processErrorHandlersInstalled = true;
  process.on('uncaughtException', (error) => {
    reportProcessError(serviceName, 'uncaughtException', error);
    process.exitCode = 1;
  });
  process.on('unhandledRejection', (error) => {
    reportProcessError(serviceName, 'unhandledRejection', error);
  });
}

function registerShutdownHooks(
  provider: BasicTracerProvider,
  loggerProvider: LoggerProvider,
  meterProvider: MeterProvider
) {
  if (shutdownHooksRegistered) {
    return;
  }

  if ('WebSocketPair' in globalThis && !('Bun' in globalThis)) {
    return;
  }

  const flush = () => {
    void provider.forceFlush();
    void loggerProvider.forceFlush();
    void meterProvider.forceFlush();
  };
  const shutdown = () => {
    void provider.shutdown();
    void loggerProvider.shutdown();
    void meterProvider.shutdown();
  };

  process.once('beforeExit', flush);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  shutdownHooksRegistered = true;
}

function createResourceAttributes(
  serviceName: string,
  resourceAttributes: Record<string, ResourceAttributeValue> | undefined
) {
  return toSpanAttributes({
    'service.name': serviceName,
    ...resourceAttributes,
  });
}

export function initBunServerObservability({
  env = process.env,
  serviceName,
  resourceAttributes,
  captureConsole = false,
}: BunServerObservabilityOptions): ResolvedHyperdxConfig {
  const resolved = applyNodeHyperdxDefaults(env, serviceName);
  if (!resolved.hasOtelAuth) {
    return resolved;
  }

  if (bunProvider) {
    if (bunProviderServiceName && bunProviderServiceName !== serviceName) {
      throw new Error(
        `Bun OpenTelemetry provider already initialized for ${bunProviderServiceName}; cannot reinitialize for ${serviceName}`
      );
    }
    return resolved;
  }

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes(createResourceAttributes(serviceName, resourceAttributes)),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: buildOtlpSignalUrl(resolved.otelExporterEndpoint, 'traces'),
          headers: parseOtelExporterHeaders(resolved.otelExporterHeaders),
        })
      ),
    ],
  });

  const exporterOptions = {
    headers: parseOtelExporterHeaders(resolved.otelExporterHeaders),
  };
  const loggerProvider = new LoggerProvider({
    resource: resourceFromAttributes(createResourceAttributes(serviceName, resourceAttributes)),
    processors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({
          ...exporterOptions,
          url: buildOtlpSignalUrl(resolved.otelExporterEndpoint, 'logs'),
        })
      ),
    ],
  });
  const meterProvider = new MeterProvider({
    resource: resourceFromAttributes(createResourceAttributes(serviceName, resourceAttributes)),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          ...exporterOptions,
          url: buildOtlpSignalUrl(resolved.otelExporterEndpoint, 'metrics'),
        }),
        exportIntervalMillis: 10_000,
      }),
    ],
  });

  trace.setGlobalTracerProvider(provider);
  logs.setGlobalLoggerProvider(loggerProvider);
  metrics.setGlobalMeterProvider(meterProvider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    })
  );

  bunProvider = provider;
  bunProviderServiceName = serviceName;
  if (captureConsole) {
    installConsoleBridge(serviceName);
  }
  installProcessErrorHandlers(serviceName);
  registerShutdownHooks(provider, loggerProvider, meterProvider);
  return resolved;
}

export const initServerObservability = initBunServerObservability;
