import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  applyNodeHyperdxDefaults,
  buildOtlpSignalUrl,
  parseOtelExporterHeaders,
  type ResolvedHyperdxConfig,
} from './hyperdx';
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

function registerShutdownHooks(provider: BasicTracerProvider) {
  if (shutdownHooksRegistered) {
    return;
  }

  const flush = () => {
    void provider.forceFlush();
  };
  const shutdown = () => {
    void provider.shutdown();
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
    resource: new Resource(createResourceAttributes(serviceName, resourceAttributes)),
  });

  provider.addSpanProcessor(
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: buildOtlpSignalUrl(resolved.otelExporterEndpoint, 'traces'),
        headers: parseOtelExporterHeaders(resolved.otelExporterHeaders),
      })
    )
  );

  provider.register({
    contextManager: new AsyncLocalStorageContextManager(),
    propagator: new W3CTraceContextPropagator(),
  });

  bunProvider = provider;
  bunProviderServiceName = serviceName;
  registerShutdownHooks(provider);
  return resolved;
}
