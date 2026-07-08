import { createApiActorBinding, createAuthUserApiActor } from '@yucp/shared/apiActor';
import { expect, test } from 'bun:test';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';

const BACKEND_URL = process.env.CONVEX_REAL_BACKEND_URL ?? 'http://127.0.0.1:3210';
const API_SECRET = 'test-convex-api-secret';
const INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-auth-secret';

test('self-hosted Convex backend executes real deployed functions', async () => {
  const correlationId = `convex-real-${Date.now()}-${crypto.randomUUID()}`;
  const authUserId = `${correlationId}-auth-user`;
  const productId = `${correlationId}-product`;
  const licenseKeyHash = `${correlationId}-license-hash`;
  const actor = await createApiActorBinding(
    createAuthUserApiActor({
      authUserId,
      source: 'session',
      now: Date.now(),
      ttlMs: 60_000,
    }),
    INTERNAL_SERVICE_AUTH_SECRET
  );
  const client = new ConvexHttpClient(BACKEND_URL, { skipConvexDeploymentUrlCheck: true });

  const created = await client.mutation(api.manualLicenses.create, {
    apiSecret: API_SECRET,
    actor,
    authUserId,
    licenseKeyHash,
    productId,
    notes: correlationId,
  });

  try {
    const validated = await client.query(api.manualLicenses.validateByHash, {
      apiSecret: API_SECRET,
      actor,
      authUserId,
      licenseKeyHash,
      productId,
    });

    expect(validated).toMatchObject({
      valid: true,
      licenseId: created.licenseId,
      status: 'active',
      currentUses: 0,
    });
  } finally {
    await client.mutation(api.manualLicenses.hardDelete, {
      apiSecret: API_SECRET,
      actor,
      authUserId,
      licenseId: created.licenseId,
    });
  }

  const afterCleanup = await client.query(api.manualLicenses.validateByHash, {
    apiSecret: API_SECRET,
    actor,
    authUserId,
    licenseKeyHash,
    productId,
  });

  expect(afterCleanup).toEqual({ valid: false, reason: 'not_found' });
});
