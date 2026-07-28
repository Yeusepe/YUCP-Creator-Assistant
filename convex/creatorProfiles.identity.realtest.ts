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
  input: {
    authUserId: string;
    deliverySlug?: string;
    name?: string;
    publicSlug?: string;
  }
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert('creator_profiles', {
      authUserId: input.authUserId,
      name: input.name ?? 'Creator 10705330',
      ownerDiscordUserId: `discord-${input.authUserId}`,
      ...(input.publicSlug ? { slug: input.publicSlug } : {}),
      ...(input.deliverySlug ? { deliverySlug: input.deliverySlug } : {}),
      status: 'active',
      policy: {},
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe('creator identity namespaces', () => {
  it('renames the creator and delivery host while retaining the old host as an owned alias', async () => {
    const t = makeTestConvex();
    await seedCreator(t, {
      authUserId: 'creator-mapache',
      deliverySlug: 'creator-10705330',
      name: 'Creator 10705330',
    });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('creator_vpm_links', {
        creatorAuthUserId: 'creator-mapache',
        creatorSlug: 'creator-10705330',
        packageId: 'com.yucp.songthing',
        linkId: 'a'.repeat(43),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });

    const updated = await t.mutation(api.creatorProfiles.updateIdentity, {
      apiSecret: 'test-secret',
      actor: await creatorActor('creator-mapache'),
      authUserId: 'creator-mapache',
      deliverySlug: 'mapache',
      name: 'Mapache',
      publicSlug: 'mapache',
    });

    expect(updated).toEqual({
      deliverySlug: 'mapache',
      name: 'Mapache',
      publicSlug: 'mapache',
    });
    const state = await t.run(async (ctx) => {
      const profile = await ctx.db
        .query('creator_profiles')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', 'creator-mapache'))
        .unique();
      const namespaces = await ctx.db
        .query('creator_namespaces')
        .withIndex('by_creator_kind', (q) =>
          q.eq('creatorAuthUserId', 'creator-mapache').eq('kind', 'delivery')
        )
        .collect();
      const link = await ctx.db
        .query('creator_vpm_links')
        .withIndex('by_link_id', (q) => q.eq('linkId', 'a'.repeat(43)))
        .unique();
      return { link, namespaces, profile };
    });

    expect(state.profile).toMatchObject({
      deliverySlug: 'mapache',
      name: 'Mapache',
      slug: 'mapache',
    });
    expect(state.link).toMatchObject({ creatorSlug: 'mapache' });
    expect(
      state.namespaces
        .map(({ slug, status }) => ({ slug, status }))
        .sort((a, b) => a.slug.localeCompare(b.slug))
    ).toEqual([
      { slug: 'creator-10705330', status: 'alias' },
      { slug: 'mapache', status: 'active' },
    ]);
    await expect(
      t.query(api.creatorProfiles.resolveDeliveryNamespace, {
        apiSecret: 'test-secret',
        creatorSlug: 'creator-10705330',
      })
    ).resolves.toMatchObject({
      authUserId: 'creator-mapache',
      canonicalSlug: 'mapache',
      status: 'alias',
    });
  });

  it('prevents another creator from claiming a current or historical namespace', async () => {
    const t = makeTestConvex();
    await seedCreator(t, {
      authUserId: 'creator-owner',
      deliverySlug: 'mapache',
      name: 'Mapache',
      publicSlug: 'mapache',
    });
    await t.mutation(api.creatorProfiles.updateIdentity, {
      apiSecret: 'test-secret',
      actor: await creatorActor('creator-owner'),
      authUserId: 'creator-owner',
      deliverySlug: 'mapache-studio',
      name: 'Mapache Studio',
      publicSlug: 'mapache-studio',
    });
    await seedCreator(t, {
      authUserId: 'creator-other',
      name: 'Other Creator',
    });

    await expect(
      t.mutation(api.creatorProfiles.updateIdentity, {
        apiSecret: 'test-secret',
        actor: await creatorActor('creator-other'),
        authUserId: 'creator-other',
        deliverySlug: 'mapache',
        name: 'Other Creator',
        publicSlug: 'other-creator',
      })
    ).rejects.toThrow(/already in use/i);
  });
});
