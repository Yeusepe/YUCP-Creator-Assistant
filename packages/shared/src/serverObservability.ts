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
}

let bunProvider: BasicTracerProvider | null = null;
let bunProviderServiceName: string | null = null;
let shutdownHooksRegistered = false;
let processErrorHandlersInstalled = false;

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
  installProcessErrorHandlers(serviceName);
  registerShutdownHooks(provider, loggerProvider, meterProvider);
  return resolved;
}

export const initServerObservability = initBunServerObservability;
