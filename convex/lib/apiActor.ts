import type { ApiActor, ApiActorBinding, ApiActorScope } from '@yucp/shared/apiActor';
import {
  createApiActorBinding,
  createServiceApiActor,
  verifyApiActorBinding,
} from '@yucp/shared/apiActor';
import { ConvexError, v } from 'convex/values';

export const ApiActorBindingV = v.object({
  payload: v.string(),
  signature: v.string(),
});

function getInternalServiceAuthSecret(): string {
  const secret = process.env.INTERNAL_SERVICE_AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error('INTERNAL_SERVICE_AUTH_SECRET is required for API actor binding');
  }
  return secret;
}

function unauthorized(message: string): never {
  throw new ConvexError(`Unauthorized: ${message}`);
}

export async function requireApiActor(actorBinding: ApiActorBinding): Promise<ApiActor> {
  const actor = await verifyApiActorBinding(actorBinding, getInternalServiceAuthSecret());
  if (!actor) {
    unauthorized('invalid actor binding');
  }
  return actor;
}

export function actorHasScope(actor: ApiActor, scope: string): boolean {
  return actor.kind === 'service' && actor.scopes.includes(scope);
}

export function assertDelegatedAuthUserActor(actor: ApiActor, authUserId: string): ApiActor {
  if (actor.kind === 'auth_user') {
    if (actor.authUserId !== authUserId) {
      unauthorized('actor does not own this auth user');
    }
    return actor;
  }

  if (actorHasScope(actor, 'creator:delegate')) {
    return actor;
  }

  unauthorized('actor cannot delegate creator access');
}

export function assertServiceActor(actor: ApiActor, requiredScopes: readonly string[]): ApiActor {
  if (actor.kind !== 'service') {
    unauthorized('service scope required');
  }

  for (const scope of requiredScopes) {
    if (!actor.scopes.includes(scope)) {
      unauthorized(`missing service scope ${scope}`);
    }
  }

  return actor;
}

export async function requireDelegatedAuthUserActor(
  actorBinding: ApiActorBinding,
  authUserId: string
): Promise<ApiActor> {
  return assertDelegatedAuthUserActor(await requireApiActor(actorBinding), authUserId);
}

export async function requireServiceActor(
  actorBinding: ApiActorBinding,
  requiredScopes: readonly string[]
): Promise<ApiActor> {
  return assertServiceActor(await requireApiActor(actorBinding), requiredScopes);
}

export async function createServiceActorBinding(input: {
  service: string;
  scopes: readonly ApiActorScope[];
  authUserId?: string;
  now?: number;
  ttlMs?: number;
}): Promise<ApiActorBinding> {
  return await createApiActorBinding(createServiceApiActor(input), getInternalServiceAuthSecret());
}
