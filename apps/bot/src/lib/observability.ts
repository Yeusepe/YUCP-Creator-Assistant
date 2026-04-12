import { initSDK, setTraceAttributes } from '@hyperdx/node-opentelemetry';
import { SpanKind, trace } from '@opentelemetry/api';
import {
  applyNodeHyperdxDefaults,
  detectServerObservabilityRuntime,
  initBunServerObservability,
  setActiveSpanAttributes,
  withObservedSpan,
} from '@yucp/shared';

const tracer = trace.getTracer('yucp-bot');
let initialized = false;

function annotateBotSpan(attributes: Record<string, string | number | boolean | undefined>) {
  setActiveSpanAttributes(attributes);

  setTraceAttributes(
    Object.fromEntries(
      Object.entries(attributes)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)])
    )
  );
}

export function initBotObservability(env: NodeJS.ProcessEnv = process.env) {
  if (detectServerObservabilityRuntime() === 'bun-manual') {
    const resolved = initBunServerObservability({
      env,
      serviceName: 'yucp-bot',
      resourceAttributes: {
        'deployment.environment': env.NODE_ENV ?? 'development',
        'service.namespace': 'yucp',
        'service.version': env.BUILD_ID ?? 'dev',
      },
    });
    initialized ||= resolved.hasOtelAuth;
    return resolved;
  }

  const resolved = applyNodeHyperdxDefaults(env, 'yucp-bot');
  if (initialized || !resolved.hasOtelAuth) {
    return resolved;
  }

  initSDK({
    consoleCapture: true,
    additionalResourceAttributes: {
      'deployment.environment': env.NODE_ENV ?? 'development',
      'service.namespace': 'yucp',
      'service.version': env.BUILD_ID ?? 'dev',
    },
  });

  initialized = true;
  return resolved;
}

export async function withBotSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  run: () => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL
): Promise<T> {
  return withObservedSpan(
    tracer,
    name,
    attributes,
    async () => {
      annotateBotSpan(attributes);
      return run();
    },
    kind
  );
}

export async function withBotStageSpan<T>(
  stage: string,
  attributes: Record<string, string | number | boolean | undefined>,
  run: () => Promise<T>
): Promise<T> {
  return withBotSpan(
    `bot.stage.${stage}`,
    {
      stage,
      ...attributes,
    },
    run
  );
}
