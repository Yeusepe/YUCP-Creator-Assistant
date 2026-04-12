import { initSDK, setTraceAttributes } from '@hyperdx/node-opentelemetry';
import { type Attributes, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { applyNodeHyperdxDefaults } from '@yucp/shared';

const tracer = trace.getTracer('yucp-bot');
let initialized = false;

function toAttributes(input: Record<string, string | number | boolean | undefined>): Attributes {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as Attributes;
}

function annotateBotSpan(attributes: Record<string, string | number | boolean | undefined>) {
  const span = trace.getActiveSpan();
  if (span) {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) {
        span.setAttribute(key, value);
      }
    }
  }

  setTraceAttributes(
    Object.fromEntries(
      Object.entries(attributes)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)])
    )
  );
}

export function initBotObservability(env: NodeJS.ProcessEnv = process.env) {
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
  return tracer.startActiveSpan(
    name,
    {
      kind,
      attributes: toAttributes(attributes),
    },
    async (span) => {
      annotateBotSpan(attributes);

      try {
        return await run();
      } catch (error) {
        if (error instanceof Error) {
          span.recordException(error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
          });
        }
        throw error;
      } finally {
        span.end();
      }
    }
  );
}
