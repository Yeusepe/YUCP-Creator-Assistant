import { createApiActorBinding, createAuthUserApiActor } from '@yucp/shared/apiActor';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex } from './testHelpers';

process.env.CONVEX_API_SECRET = 'test-secret';
process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';

async function creatorActor(authUserId: string) {
  return await createApiActorBinding(
    createAuthUserApiActor({ authUserId, source: 'session' }),
    process.env.INTERNAL_SERVICE_AUTH_SECRET as string
  );
}

async function seedCreator(
  t: ReturnType<typeof makeTestConvex>,
  authUserId: string,
  slug?: string
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert('creator_profiles', {
      authUserId,
      name: 'Mapache Studio',
      ownerDiscordUserId: `discord-${authUserId}`,
      ...(slug ? { slug } : {}),
      status: 'active',
      policy: {},
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe('creator delivery slugs', () => {
  it('assigns the first available stable slug to a creator profile', async () => {
    const t = makeTestConvex();
    await seedCreator(t, 'creator-mapache');

    const assigned = await t.mutation(api.creatorProfiles.ensureDeliverySlug, {
      apiSecret: 'test-secret',
      actor: await creatorActor('creator-mapache'),
      authUserId: 'creator-mapache',
      proposedSlugs: ['mapache-studio', 'mapache-studio-1234567890'],
    });
    const repeated = await t.mutation(api.creatorProfiles.ensureDeliverySlug, {
      apiSecret: 'test-secret',
      actor: await creatorActor('creator-mapache'),
      authUserId: 'creator-mapache',
      proposedSlugs: ['different-name', 'different-name-1234567890'],
    });

    expect(assigned).toEqual({ created: true, slug: 'mapache-studio' });
    expect(repeated).toEqual({ created: false, slug: 'mapache-studio' });
    const profile = await t.run(
      async (ctx) =>
        await ctx.db
          .query('creator_profiles')
          .withIndex('by_auth_user', (q) => q.eq('authUserId', 'creator-mapache'))
          .unique()
    );
    expect(profile).toMatchObject({ deliverySlug: 'mapache-studio' });
    expect(profile?.slug).toBeUndefined();
  });

  it('selects the next candidate when another creator owns the preferred slug', async () => {
    const t = makeTestConvex();
    await seedCreator(t, 'creator-first', 'mapache-studio');
    await seedCreator(t, 'creator-second');

    const assigned = await t.mutation(api.creatorProfiles.ensureDeliverySlug, {
      apiSecret: 'test-secret',
      actor: await creatorActor('creator-second'),
      authUserId: 'creator-second',
      proposedSlugs: ['mapache-studio', 'mapache-studio-abcdef1234'],
    });

    expect(assigned).toEqual({ created: true, slug: 'mapache-studio-abcdef1234' });
  });

  it('does not rewrite an existing public creator slug to make it DNS-compatible', async () => {
    const t = makeTestConvex();
    const publicSlug = 'a'.repeat(64);
    await seedCreator(t, 'creator-long-public-slug', publicSlug);

    const assigned = await t.mutation(api.creatorProfiles.ensureDeliverySlug, {
      apiSecret: 'test-secret',
      actor: await creatorActor('creator-long-public-slug'),
      authUserId: 'creator-long-public-slug',
      proposedSlugs: ['mapache-studio', 'mapache-studio-1234567890'],
    });
    const profile = await t.run(
      async (ctx) =>
        await ctx.db
          .query('creator_profiles')
          .withIndex('by_auth_user', (q) => q.eq('authUserId', 'creator-long-public-slug'))
          .unique()
    );

    expect(assigned).toEqual({ created: true, slug: 'mapache-studio' });
    expect(profile).toMatchObject({
      deliverySlug: 'mapache-studio',
      slug: publicSlug,
    });
  });

  it('does not let one creator assign another creator delivery slug', async () => {
    const t = makeTestConvex();
    await seedCreator(t, 'creator-owner');

    await expect(
      t.mutation(api.creatorProfiles.ensureDeliverySlug, {
        apiSecret: 'test-secret',
        actor: await creatorActor('creator-attacker'),
        authUserId: 'creator-owner',
        proposedSlugs: ['stolen-slug'],
      })
    ).rejects.toThrow();
  });
});
