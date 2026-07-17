import { createApiActorBinding, createServiceApiActor } from '@yucp/shared/apiActor';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex, seedEntitlement, seedSubject } from './testHelpers';

const API_SECRET = 'buyer-holder-entitlement-api-secret';
const ACTOR_SECRET = 'buyer-holder-entitlement-actor-secret';

describe('buyer-held entitlement listing', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
    process.env.INTERNAL_SERVICE_AUTH_SECRET = ACTOR_SECRET;
  });

  afterEach(() => {
    delete process.env.CONVEX_API_SECRET;
    delete process.env.INTERNAL_SERVICE_AUTH_SECRET;
  });

  it('lists active entitlements across creators for active subjects owned by the buyer', async () => {
    const t = makeTestConvex({ injectActor: false });
    const buyerAuthUserId = 'buyer-auth-user';
    const activeSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'buyer-discord-active',
      status: 'active',
    });
    const secondActiveSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'buyer-discord-second-active',
      status: 'active',
    });
    const suspendedSubjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'buyer-discord-suspended',
      status: 'suspended',
    });
    const otherBuyerSubjectId = await seedSubject(t, {
      authUserId: 'other-buyer',
      primaryDiscordUserId: 'other-buyer-discord',
      status: 'active',
    });
    await seedEntitlement(t, activeSubjectId, {
      authUserId: 'creator-a',
      productId: 'product-a',
      status: 'active',
    });
    await seedEntitlement(t, secondActiveSubjectId, {
      authUserId: 'creator-a',
      productId: 'product-second-subject',
      status: 'active',
    });
    await seedEntitlement(t, activeSubjectId, {
      authUserId: 'creator-b',
      productId: 'product-b',
      status: 'active',
    });
    await seedEntitlement(t, activeSubjectId, {
      authUserId: 'creator-c',
      productId: 'product-revoked',
      status: 'revoked',
    });
    await seedEntitlement(t, suspendedSubjectId, {
      authUserId: 'creator-d',
      productId: 'product-suspended-subject',
      status: 'active',
    });
    await seedEntitlement(t, otherBuyerSubjectId, {
      authUserId: 'creator-e',
      productId: 'product-other-buyer',
      status: 'active',
    });
    const actor = await createApiActorBinding(
      createServiceApiActor({
        authUserId: buyerAuthUserId,
        service: 'vpm-repository',
        scopes: ['entitlements:service'],
      }),
      ACTOR_SECRET
    );

    const result = await t.query(api.entitlements.listByAuthUser, {
      apiSecret: API_SECRET,
      actor,
      authUserId: buyerAuthUserId,
      scope: 'subject_holder',
      status: 'active',
      limit: 100,
    });

    expect(result.data.map((entry) => entry.productId).sort()).toEqual([
      'product-a',
      'product-b',
      'product-second-subject',
    ]);
  });

  it('rejects a holder query when the service actor is bound to another buyer', async () => {
    const t = makeTestConvex({ injectActor: false });
    const actor = await createApiActorBinding(
      createServiceApiActor({
        authUserId: 'other-buyer',
        service: 'vpm-repository',
        scopes: ['entitlements:service'],
      }),
      ACTOR_SECRET
    );

    await expect(
      t.query(api.entitlements.listByAuthUser, {
        apiSecret: API_SECRET,
        actor,
        authUserId: 'buyer-auth-user',
        scope: 'subject_holder',
        status: 'active',
      })
    ).rejects.toThrow('Unauthorized');
  });
});
