import type { ApiActorBinding, AuthUserApiActor } from '@yucp/shared/apiActor';
import {
  createApiActorBinding,
  createAuthUserApiActor,
  createServiceApiActor,
} from '@yucp/shared/apiActor';

function getInternalServiceAuthSecret(): string {
  const secret = process.env.INTERNAL_SERVICE_AUTH_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === 'test') {
      return 'test-internal-service-secret';
    }
    throw new Error('INTERNAL_SERVICE_AUTH_SECRET is required');
  }
  return secret;
}

export async function createAuthUserActorBinding(input: {
  authUserId: string;
  source: AuthUserApiActor['source'];
  scopes?: readonly string[];
  keyId?: string;
}): Promise<ApiActorBinding> {
  return await createApiActorBinding(createAuthUserApiActor(input), getInternalServiceAuthSecret());
}

export async function createApiServiceActorBinding(input: {
  service: string;
  scopes: readonly string[];
  authUserId?: string;
}): Promise<ApiActorBinding> {
  return await createApiActorBinding(createServiceApiActor(input), getInternalServiceAuthSecret());
}
