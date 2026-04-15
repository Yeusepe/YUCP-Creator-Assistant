import { describe, expect, it } from 'bun:test';
import {
  API_ACTOR_TTL_MS,
  createApiActorBinding,
  createServiceApiActor,
  verifyApiActorBinding,
} from './apiActor';

describe('apiActor', () => {
  it('round-trips a valid service actor binding', async () => {
    const now = Date.now();
    const actor = createServiceApiActor({
      service: 'test-service',
      scopes: ['downloads:service'],
      now,
      ttlMs: API_ACTOR_TTL_MS,
    });

    const binding = await createApiActorBinding(actor, 'test-secret');

    await expect(verifyApiActorBinding(binding, 'test-secret', now + 1_000)).resolves.toEqual(actor);
  });

  it('rejects malformed signatures before verification', async () => {
    const now = Date.now();
    const actor = createServiceApiActor({
      service: 'test-service',
      scopes: ['downloads:service'],
      now,
    });
    const binding = await createApiActorBinding(actor, 'test-secret');

    await expect(
      verifyApiActorBinding(
        {
          ...binding,
          signature: 'not-hex',
        },
        'test-secret',
        now
      )
    ).resolves.toBeNull();
  });
});
