import type { ApiActorBinding } from '@yucp/shared/apiActor';
import {
  createApiActorBinding,
  createServiceApiActor,
  isApiActorProtectedFunction,
} from '@yucp/shared/apiActor';
import { ConvexHttpClient } from 'convex/browser';
import { getFunctionName } from 'convex/server';

const DEFAULT_BOT_SERVICE_SCOPES = [
  'creator:delegate',
  'downloads:service',
  'entitlements:service',
  'manual-licenses:service',
  'subjects:service',
  'verification-intents:service',
  'verification-sessions:service',
] as const;

let cachedDefaultBotActor: {
  binding: ApiActorBinding;
  expiresAt: number;
} | null = null;

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

async function getDefaultBotActorBinding(): Promise<ApiActorBinding | undefined> {
  const secret = process.env.INTERNAL_SERVICE_AUTH_SECRET?.trim();
  if (!secret) {
    return undefined;
  }

  const now = Date.now();
  if (cachedDefaultBotActor && cachedDefaultBotActor.expiresAt > now + 30_000) {
    return cachedDefaultBotActor.binding;
  }

  const actor = createServiceApiActor({
    service: 'discord-bot',
    scopes: DEFAULT_BOT_SERVICE_SCOPES,
    now,
  });
  const binding = await createApiActorBinding(actor, secret);
  cachedDefaultBotActor = {
    binding,
    expiresAt: actor.expiresAt,
  };
  return binding;
}

export async function getRequiredBotActorBinding(): Promise<ApiActorBinding> {
  const actor = await getDefaultBotActorBinding();
  if (!actor) {
    throw new Error('INTERNAL_SERVICE_AUTH_SECRET is required for protected bot Convex calls');
  }
  return actor;
}

function mergeActorArg(args: unknown, actor: ApiActorBinding): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { actor };
  }
  if ('actor' in (args as Record<string, unknown>)) {
    return args;
  }

  return {
    ...(args as Record<string, unknown>),
    actor,
  };
}

function shouldAttachActor(functionReference: unknown, args: unknown): boolean {
  return (
    isApiActorProtectedFunction(describeFunctionReference(functionReference)) &&
    !!args &&
    typeof args === 'object' &&
    !Array.isArray(args) &&
    'apiSecret' in (args as Record<string, unknown>) &&
    !('actor' in (args as Record<string, unknown>))
  );
}

export function createBotConvexClient(convexUrl: string): ConvexHttpClient {
  const client = new ConvexHttpClient(convexUrl);

  const rawQuery = client.query.bind(client);
  const rawMutation = client.mutation.bind(client);
  const rawAction = client.action.bind(client);

  client.query = (async (functionReference: unknown, args?: unknown) => {
    const actor = shouldAttachActor(functionReference, args)
      ? await getDefaultBotActorBinding()
      : undefined;
    return await rawQuery(
      functionReference as never,
      actor ? (mergeActorArg(args, actor) as never) : (args as never)
    );
  }) as typeof client.query;

  client.mutation = (async (functionReference: unknown, args?: unknown) => {
    const actor = shouldAttachActor(functionReference, args)
      ? await getDefaultBotActorBinding()
      : undefined;
    return await rawMutation(
      functionReference as never,
      actor ? (mergeActorArg(args, actor) as never) : (args as never)
    );
  }) as typeof client.mutation;

  client.action = (async (functionReference: unknown, args?: unknown) => {
    const actor = shouldAttachActor(functionReference, args)
      ? await getDefaultBotActorBinding()
      : undefined;
    return await rawAction(
      functionReference as never,
      actor ? (mergeActorArg(args, actor) as never) : (args as never)
    );
  }) as typeof client.action;

  return client;
}
