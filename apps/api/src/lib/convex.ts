/**
 * Convex HTTP client for server-side API calls.
 * Used by install and verification routes to call Convex mutations.
 */

import { SpanKind } from '@opentelemetry/api';
import type { ApiActorBinding } from '@yucp/shared/apiActor';
import {
  createApiActorBinding,
  createServiceApiActor,
  isApiActorProtectedFunction,
} from '@yucp/shared/apiActor';
import { ConvexHttpClient } from 'convex/browser';
import { getFunctionName } from 'convex/server';
import { withApiSpan } from './observability';

type ConvexServerClient = {
  // biome-ignore lint/suspicious/noExplicitAny: Convex server wrappers are intentionally dynamic at this boundary.
  query: (functionReference: unknown, args?: unknown) => Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: Convex server wrappers are intentionally dynamic at this boundary.
  mutation: (functionReference: unknown, args?: unknown) => Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: Convex server wrappers are intentionally dynamic at this boundary.
  action: (functionReference: unknown, args?: unknown) => Promise<any>;
};

export type { ConvexServerClient };

let client: ConvexServerClient | null = null;
let cachedDefaultServiceActor: {
  binding: ApiActorBinding;
  expiresAt: number;
} | null = null;

const DEFAULT_API_SERVICE_SCOPES = [
  'creator:delegate',
  'downloads:service',
  'entitlements:service',
  'manual-licenses:service',
  'subjects:service',
  'verification-intents:service',
  'verification-sessions:service',
] as const;

function resolveConvexUrl(url: string): string {
  return url.startsWith('http')
    ? url
    : `https://${url.includes(':') ? url.split(':')[1] : url}.convex.cloud`;
}

function describeFunctionReference(functionReference: unknown): string {
  try {
    return getFunctionName(functionReference as never);
  } catch {
    // Fall through to ad hoc inspection for simple string mocks.
  }
  if (typeof functionReference === 'string') {
    return functionReference;
  }
  if (!functionReference || typeof functionReference !== 'object') {
    return 'unknown';
  }

  const candidate = functionReference as {
    name?: unknown;
    _name?: unknown;
    functionName?: unknown;
    canonicalReference?: unknown;
  };

  if (typeof candidate.name === 'string') return candidate.name;
  if (typeof candidate._name === 'string') return candidate._name;
  if (typeof candidate.functionName === 'string') return candidate.functionName;
  if (typeof candidate.canonicalReference === 'string') return candidate.canonicalReference;
  return 'unknown';
}

function describeArgs(args: unknown) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {
      argCount: 0,
      hasApiSecret: false,
      hasActor: false,
    };
  }

  const keys = Object.keys(args);
  return {
    argCount: keys.length,
    hasApiSecret: keys.includes('apiSecret'),
    hasActor: keys.includes('actor'),
  };
}

async function getDefaultServiceActorBinding(): Promise<ApiActorBinding | null> {
  const secret = process.env.INTERNAL_SERVICE_AUTH_SECRET?.trim();
  if (!secret) {
    return null;
  }

  const now = Date.now();
  if (cachedDefaultServiceActor && cachedDefaultServiceActor.expiresAt > now + 30_000) {
    return cachedDefaultServiceActor.binding;
  }

  const actor = createServiceApiActor({
    service: 'api-server',
    scopes: DEFAULT_API_SERVICE_SCOPES,
    now,
  });
  const binding = await createApiActorBinding(actor, secret);
  cachedDefaultServiceActor = {
    binding,
    expiresAt: actor.expiresAt,
  };
  return binding;
}

async function resolveActorBinding(
  functionReference: unknown,
  args: unknown,
  explicitActor?: ApiActorBinding
): Promise<ApiActorBinding | undefined> {
  const functionName = describeFunctionReference(functionReference);
  if (
    !isApiActorProtectedFunction(functionName) ||
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    !('apiSecret' in (args as Record<string, unknown>))
  ) {
    return undefined;
  }

  return explicitActor ?? (await getDefaultServiceActorBinding()) ?? undefined;
}

function mergeActorArg(args: unknown, actor: ApiActorBinding): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { actor };
  }

  return {
    ...(args as Record<string, unknown>),
    actor,
  };
}

function createObservedConvexClient(
  convexUrl: string,
  actor?: ApiActorBinding
): ConvexServerClient {
  const rawClient = new ConvexHttpClient(convexUrl) as unknown as ConvexServerClient;
  const endpointHost = new URL(convexUrl).host;

  const invoke = (
    operation: 'query' | 'mutation' | 'action',
    functionReference: unknown,
    args?: unknown
  ) =>
    withApiSpan(
      `convex.${operation}`,
      {
        'convex.operation': operation,
        'convex.function': describeFunctionReference(functionReference),
        'convex.endpoint_host': endpointHost,
        ...describeArgs(args),
      },
      async () => {
        const resolvedActor = await resolveActorBinding(functionReference, args, actor);
        const requestArgs = resolvedActor ? mergeActorArg(args, resolvedActor) : args;
        return await rawClient[operation](functionReference, requestArgs);
      },
      SpanKind.CLIENT
    );

  return {
    query: (functionReference, args) => invoke('query', functionReference, args),
    mutation: (functionReference, args) => invoke('mutation', functionReference, args),
    action: (functionReference, args) => invoke('action', functionReference, args),
  };
}

/**
 * Create a Convex HTTP client from a URL.
 * Use when URL comes from config (e.g. verification routes).
 */
export function getConvexClientFromUrl(url: string, actor?: ApiActorBinding): ConvexServerClient {
  return createObservedConvexClient(resolveConvexUrl(url), actor);
}

/**
 * Get or create the Convex HTTP client.
 * Uses CONVEX_URL and requires CONVEX_API_SECRET for authenticated calls.
 */
export function getConvexClient(): ConvexServerClient {
  if (!client) {
    const url = process.env.CONVEX_URL ?? process.env.CONVEX_DEPLOYMENT;
    if (!url) {
      throw new Error('CONVEX_URL or CONVEX_DEPLOYMENT must be set for Convex client');
    }
    client = createObservedConvexClient(resolveConvexUrl(url));
  }
  return client;
}

/**
 * Get the API secret for Convex mutations.
 * Must match CONVEX_API_SECRET in Convex deployment.
 */
export function getConvexApiSecret(): string {
  const secret = process.env.CONVEX_API_SECRET;
  if (!secret) {
    throw new Error('CONVEX_API_SECRET must be set for Convex API calls');
  }
  return secret;
}
