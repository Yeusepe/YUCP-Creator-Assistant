import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from './_generated/dataModel';
import { enqueueRoleRemoval, enqueueRoleSync } from './lib/roleSyncEnqueue';
import { makeTestConvex, seedSubject } from './testHelpers';
import {
  emitRoleRemovalJobs,
  emitRoleSyncJob,
  projectEntitlementFromPurchaseFact,
  revokeEntitlementForPurchaseFact,
  sha256Hex,
} from './webhooks/_helpers';
import { processLemonEvent } from './webhooks/lemonsqueezy';

describe('enqueueRoleSync idempotency (legacy / flag-off path)', () => {
  const original = process.env.ROLE_SYNC_VIA_WORKPOOL;
  beforeEach(() => {
    // Flag off: the helper only writes the projection row (no Workpool enqueue),
    // which the convex-test harness can exercise without the component.
    delete process.env.ROLE_SYNC_VIA_WORKPOOL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.ROLE_SYNC_VIA_WORKPOOL;
    else process.env.ROLE_SYNC_VIA_WORKPOOL = original;
  });

  async function seedLemonBuyer(
    t: ReturnType<typeof makeTestConvex>,
    params: {
      authUserId: string;
      email: string;
      discordUserId: string;
    }
  ) {
    const subjectId = await seedSubject(t, {
      authUserId: params.authUserId,
      primaryDiscordUserId: params.discordUserId,
    });
    const emailHash = await sha256Hex(params.email);
    const providerConnectionId = await t.run(async (ctx) => {
      const externalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'lemonsqueezy',
        providerUserId: `lemon-buyer-${params.discordUserId}`,
        emailHash,
        status: 'active',
        createdAt: 1_000,
        updatedAt: 1_000,
      });
      await ctx.db.insert('bindings', {
        authUserId: params.authUserId,
        subjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        version: 1,
        createdAt: 1_000,
        updatedAt: 1_000,
      });
      return await ctx.db.insert('provider_connections', {
        authUserId: params.authUserId,
        provider: 'lemonsqueezy',
        providerKey: 'lemonsqueezy',
        status: 'active',
        webhookConfigured: true,
        createdAt: 1_000,
        updatedAt: 1_000,
      });
    });
    return { subjectId, providerConnectionId };
  }

  function lemonOrderPayload(params: {
    orderId: string;
    email: string;
    variantId: string;
    eventName: string;
    refunded?: boolean;
  }) {
    return {
      meta: { event_name: params.eventName },
      data: {
        id: params.orderId,
        attributes: {
          user_email: params.email,
          first_order_item: {
            id: `item-${params.orderId}`,
            variant_id: params.variantId,
            product_id: `product-${params.variantId}`,
          },
          created_at: '2026-06-15T00:00:00.000Z',
          refunded: params.refunded,
          refunded_at: params.refunded ? '2026-06-15T00:00:00.000Z' : undefined,
        },
      },
    };
  }

  async function seedLemonWebhookEvent(
    t: ReturnType<typeof makeTestConvex>,
    params: {
      authUserId: string;
      providerConnectionId: Id<'provider_connections'>;
      providerEventId: string;
      eventType: string;
      payload: Record<string, unknown>;
    }
  ): Promise<Id<'webhook_events'>> {
    return await t.run(async (ctx) =>
      ctx.db.insert('webhook_events', {
        provider: 'lemonsqueezy',
        providerKey: 'lemonsqueezy',
        providerConnectionId: params.providerConnectionId,
        providerEventId: params.providerEventId,
        eventType: params.eventType,
        rawPayload: params.payload,
        signatureValid: true,
        verificationMethod: 'hmac',
        authenticated: true,
        status: 'pending',
        authUserId: params.authUserId,
        receivedAt: 1_000,
      })
    );
  }

  it('inserts one row and dedupes a repeat enqueue with the same idempotency key', async () => {
    const t = makeTestConvex();
    const params = {
      authUserId: 'auth-enqueue',
      subjectId: 'subject-enqueue' as Id<'subjects'>,
      entitlementId: 'entitlement-enqueue' as Id<'entitlements'>,
      discordUserId: 'discord-enqueue',
      targetGuildId: 'guild-enqueue',
      idempotencyKey: 'role_sync:auth-enqueue:subject-enqueue:entitlement-enqueue',
    };

    const firstId = await t.run(async (ctx) => enqueueRoleSync(ctx, params));
    const secondId = await t.run(async (ctx) => enqueueRoleSync(ctx, params));

    expect(secondId).toBe(firstId);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('outbox_jobs')
        .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', params.idempotencyKey))
        .collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobType).toBe('role_sync');
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.targetGuildId).toBe('guild-enqueue');
    expect((rows[0]?.payload as { entitlementId?: string }).entitlementId).toBe(
      'entitlement-enqueue'
    );
  });

  it('rejects blank idempotency keys before writing role sync work', async () => {
    const t = makeTestConvex();
    await expect(
      t.run(async (ctx) =>
        enqueueRoleSync(ctx, {
          authUserId: 'auth-enqueue',
          subjectId: 'subject-enqueue' as Id<'subjects'>,
          entitlementId: 'entitlement-enqueue' as Id<'entitlements'>,
          discordUserId: 'discord-enqueue',
          idempotencyKey: '   ',
        })
      )
    ).rejects.toThrow(/idempotencyKey/);
  });

  it('rejects retry budgets outside the supported range', async () => {
    const t = makeTestConvex();

    await expect(
      t.run(async (ctx) =>
        enqueueRoleSync(ctx, {
          authUserId: 'auth-enqueue',
          subjectId: 'subject-enqueue' as Id<'subjects'>,
          entitlementId: 'entitlement-enqueue' as Id<'entitlements'>,
          idempotencyKey: 'role_sync:auth-enqueue:subject-enqueue:retry-low',
          maxRetries: -1,
        })
      )
    ).rejects.toThrow(/maxRetries/);

    await expect(
      t.run(async (ctx) =>
        enqueueRoleRemoval(ctx, {
          authUserId: 'auth-enqueue',
          subjectId: 'subject-enqueue' as Id<'subjects'>,
          guildId: 'guild-enqueue',
          roleId: 'role-enqueue',
          idempotencyKey: 'role_removal:auth-enqueue:subject-enqueue:retry-high',
          maxRetries: 101,
        })
      )
    ).rejects.toThrow(/maxRetries/);
  });

  it('dedupes repeated webhook role sync emissions for the same entitlement', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-webhook-sync';
    const subjectId = 'subject-webhook-sync' as Id<'subjects'>;
    const entitlementId = 'entitlement-webhook-sync' as Id<'entitlements'>;

    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_001)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(2_001);

    await t.run(async (ctx) =>
      emitRoleSyncJob(ctx, authUserId, subjectId, 'discord-webhook-sync', entitlementId)
    );
    await t.run(async (ctx) =>
      emitRoleSyncJob(ctx, authUserId, subjectId, 'discord-webhook-sync', entitlementId)
    );

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('outbox_jobs')
        .withIndex('by_idempotency', (q) =>
          q.eq('idempotencyKey', `role_sync:${authUserId}:${subjectId}:${entitlementId}`)
        )
        .collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobType).toBe('role_sync');
  });

  it('enqueues fresh lifecycle role sync work after a previous row is finalized', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-webhook-sync-lifecycle';
    const subjectId = 'subject-webhook-sync-lifecycle' as Id<'subjects'>;
    const entitlementId = 'entitlement-webhook-sync-lifecycle' as Id<'entitlements'>;
    const idempotencyKey = `role_sync:${authUserId}:${subjectId}:${entitlementId}`;

    const firstId = await t.run(async (ctx) => {
      await emitRoleSyncJob(ctx, authUserId, subjectId, 'discord-webhook-sync', entitlementId);
      const first = await ctx.db
        .query('outbox_jobs')
        .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', idempotencyKey))
        .first();
      if (!first) {
        throw new Error('Expected initial role sync row');
      }
      await ctx.db.patch(first._id, {
        status: 'completed',
        completedAt: Date.now(),
        updatedAt: Date.now(),
      });
      return first._id;
    });

    const secondId = await t.run(async (ctx) => {
      await emitRoleSyncJob(ctx, authUserId, subjectId, 'discord-webhook-sync', entitlementId);
      const rows = await ctx.db
        .query('outbox_jobs')
        .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', idempotencyKey))
        .collect();
      const pending = rows.find((row) => row.status === 'pending');
      if (!pending) {
        throw new Error('Expected fresh pending role sync row');
      }
      return pending._id;
    });

    expect(secondId).not.toBe(firstId);
  });

  it('enqueues fresh webhook grant work when an obsolete pending row uses the previous lifecycle key', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-webhook-sync-stale-pending';
    const subjectId = await seedSubject(t, {
      primaryDiscordUserId: 'discord-webhook-sync-stale-pending',
    });
    const sourceReference = 'source-webhook-sync-stale-pending';
    const productId = 'product-webhook-sync-stale-pending';

    const { entitlementId, staleOutboxJobId } = await t.run(async (ctx) => {
      const now = 1_000;
      const insertedEntitlementId = await ctx.db.insert('entitlements', {
        authUserId,
        subjectId,
        productId,
        sourceProvider: 'gumroad',
        sourceReference,
        status: 'revoked',
        policySnapshotVersion: 1,
        grantedAt: now,
        revokedAt: 2_000,
        updatedAt: 2_000,
      });
      const insertedStaleOutboxJobId = await ctx.db.insert('outbox_jobs', {
        authUserId,
        jobType: 'role_sync',
        payload: {
          subjectId,
          entitlementId: insertedEntitlementId,
          discordUserId: 'discord-webhook-sync-stale-pending',
        },
        status: 'pending',
        idempotencyKey: `role_sync:${authUserId}:${subjectId}:${insertedEntitlementId}`,
        targetDiscordUserId: 'discord-webhook-sync-stale-pending',
        retryCount: 0,
        maxRetries: 10,
        createdAt: 1_500,
        updatedAt: 1_500,
      });
      return { entitlementId: insertedEntitlementId, staleOutboxJobId: insertedStaleOutboxJobId };
    });

    vi.spyOn(Date, 'now').mockReturnValue(3_000);
    await t.run(async (ctx) =>
      projectEntitlementFromPurchaseFact(
        ctx,
        authUserId,
        subjectId,
        productId,
        sourceReference,
        1_000
      )
    );

    const roleSyncRows = await t.run(async (ctx) =>
      ctx.db
        .query('outbox_jobs')
        .withIndex('by_auth_user_type', (q) =>
          q.eq('authUserId', authUserId).eq('jobType', 'role_sync')
        )
        .collect()
    );
    const freshRow = roleSyncRows.find((row) => row._id !== staleOutboxJobId);

    expect(roleSyncRows).toHaveLength(2);
    expect(freshRow?.idempotencyKey).toBe(
      `role_sync:${authUserId}:${subjectId}:${entitlementId}:grant:3000`
    );
  });

  it('enqueues fresh Lemon grant work when an obsolete pending row uses the previous lifecycle key', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-lemon-sync-stale-pending';
    const email = 'lemon-sync-stale@example.com';
    const discordUserId = 'discord-lemon-sync-stale-pending';
    const variantId = 'variant-lemon-sync-stale-pending';
    const sourceReference = 'lemonsqueezy:order:order-lemon-sync-stale-pending';
    const { subjectId, providerConnectionId } = await seedLemonBuyer(t, {
      authUserId,
      email,
      discordUserId,
    });

    const { entitlementId, staleOutboxJobId } = await t.run(async (ctx) => {
      const insertedEntitlementId = await ctx.db.insert('entitlements', {
        authUserId,
        subjectId,
        productId: variantId,
        sourceProvider: 'lemonsqueezy',
        sourceReference,
        status: 'revoked',
        policySnapshotVersion: 1,
        grantedAt: 1_000,
        revokedAt: 2_000,
        updatedAt: 2_000,
      });
      const insertedStaleOutboxJobId = await ctx.db.insert('outbox_jobs', {
        authUserId,
        jobType: 'role_sync',
        payload: {
          subjectId,
          entitlementId: insertedEntitlementId,
          discordUserId,
        },
        status: 'pending',
        idempotencyKey: `role_sync:${authUserId}:${subjectId}:${insertedEntitlementId}`,
        targetDiscordUserId: discordUserId,
        retryCount: 0,
        maxRetries: 10,
        createdAt: 1_500,
        updatedAt: 1_500,
      });
      return { entitlementId: insertedEntitlementId, staleOutboxJobId: insertedStaleOutboxJobId };
    });

    const payload = lemonOrderPayload({
      orderId: 'order-lemon-sync-stale-pending',
      email,
      variantId,
      eventName: 'order_created',
    });
    const webhookEventId = await seedLemonWebhookEvent(t, {
      authUserId,
      providerConnectionId,
      providerEventId: 'order-lemon-sync-stale-pending:order_created',
      eventType: 'order_created',
      payload,
    });

    vi.spyOn(Date, 'now').mockReturnValue(3_000);
    await t.run(async (ctx) =>
      processLemonEvent(
        ctx,
        authUserId,
        {
          _id: webhookEventId,
          providerConnectionId,
          eventType: 'order_created',
        },
        payload
      )
    );

    const roleSyncRows = await t.run(async (ctx) =>
      ctx.db
        .query('outbox_jobs')
        .withIndex('by_auth_user_type', (q) =>
          q.eq('authUserId', authUserId).eq('jobType', 'role_sync')
        )
        .collect()
    );
    const freshRow = roleSyncRows.find((row) => row._id !== staleOutboxJobId);

    expect(roleSyncRows).toHaveLength(2);
    expect(freshRow?.idempotencyKey).toBe(
      `role_sync:${authUserId}:${subjectId}:${entitlementId}:grant:3000`
    );
  });

  it('dedupes repeated webhook role removal emissions for the same role rule', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-webhook-removal';
    const subjectId = 'subject-webhook-removal' as Id<'subjects'>;
    const productId = 'product-webhook-removal';
    const guildId = 'guild-webhook-removal';
    const now = 1_000;

    await t.run(async (ctx) => {
      const guildLinkId = await ctx.db.insert('guild_links', {
        authUserId,
        discordGuildId: guildId,
        installedByAuthUserId: authUserId,
        botPresent: true,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('role_rules', {
        authUserId,
        guildId,
        guildLinkId,
        productId,
        verifiedRoleId: 'role-webhook-removal',
        removeOnRevoke: true,
        priority: 0,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    });

    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(2_001)
      .mockReturnValueOnce(3_000)
      .mockReturnValueOnce(3_001);

    await t.run(async (ctx) =>
      emitRoleRemovalJobs(
        ctx,
        authUserId,
        subjectId,
        productId,
        'discord-webhook-removal',
        'entitlement-webhook-removal' as Id<'entitlements'>
      )
    );
    await t.run(async (ctx) =>
      emitRoleRemovalJobs(
        ctx,
        authUserId,
        subjectId,
        productId,
        'discord-webhook-removal',
        'entitlement-webhook-removal' as Id<'entitlements'>
      )
    );

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('outbox_jobs')
        .withIndex('by_idempotency', (q) =>
          q.eq(
            'idempotencyKey',
            `role_removal:${authUserId}:${subjectId}:${guildId}:${productId}:role-webhook-removal:entitlement-webhook-removal`
          )
        )
        .collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobType).toBe('role_removal');
    expect((rows[0]?.payload as { entitlementId?: string }).entitlementId).toBe(
      'entitlement-webhook-removal'
    );
  });

  it('enqueues fresh webhook removal work when an obsolete pending row uses the previous lifecycle key', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-webhook-removal-stale-pending';
    const subjectId = await seedSubject(t, {
      primaryDiscordUserId: 'discord-webhook-removal-stale-pending',
    });
    const productId = 'product-webhook-removal-stale-pending';
    const sourceReference = 'source-webhook-removal-stale-pending';
    const guildId = 'guild-webhook-removal-stale-pending';
    const roleId = 'role-webhook-removal-stale-pending';

    const { entitlementId, staleOutboxJobId } = await t.run(async (ctx) => {
      const now = 1_000;
      const guildLinkId = await ctx.db.insert('guild_links', {
        authUserId,
        discordGuildId: guildId,
        installedByAuthUserId: authUserId,
        botPresent: true,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('role_rules', {
        authUserId,
        guildId,
        guildLinkId,
        productId,
        verifiedRoleId: roleId,
        removeOnRevoke: true,
        priority: 0,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      const insertedEntitlementId = await ctx.db.insert('entitlements', {
        authUserId,
        subjectId,
        productId,
        sourceProvider: 'gumroad',
        sourceReference,
        status: 'active',
        policySnapshotVersion: 1,
        grantedAt: now,
        updatedAt: now,
      });
      const insertedStaleOutboxJobId = await ctx.db.insert('outbox_jobs', {
        authUserId,
        jobType: 'role_removal',
        payload: {
          subjectId,
          entitlementId: insertedEntitlementId,
          guildId,
          roleId,
          discordUserId: 'discord-webhook-removal-stale-pending',
        },
        status: 'pending',
        idempotencyKey: `role_removal:${authUserId}:${subjectId}:${guildId}:${productId}:${roleId}`,
        targetGuildId: guildId,
        targetDiscordUserId: 'discord-webhook-removal-stale-pending',
        retryCount: 0,
        maxRetries: 10,
        createdAt: 1_500,
        updatedAt: 1_500,
      });
      return { entitlementId: insertedEntitlementId, staleOutboxJobId: insertedStaleOutboxJobId };
    });

    vi.spyOn(Date, 'now').mockReturnValue(3_000);
    await t.run(async (ctx) =>
      revokeEntitlementForPurchaseFact(ctx, authUserId, { subjectId }, sourceReference)
    );

    const roleRemovalRows = await t.run(async (ctx) =>
      ctx.db
        .query('outbox_jobs')
        .withIndex('by_auth_user_type', (q) =>
          q.eq('authUserId', authUserId).eq('jobType', 'role_removal')
        )
        .collect()
    );
    const freshRow = roleRemovalRows.find((row) => row._id !== staleOutboxJobId);

    expect(roleRemovalRows).toHaveLength(2);
    expect(freshRow?.idempotencyKey).toBe(
      `role_removal:${authUserId}:${subjectId}:${guildId}:${productId}:${roleId}:${entitlementId}:revoke:3000`
    );
  });

  it('enqueues fresh Lemon removal work with entitlement guard when an obsolete pending row uses the previous lifecycle key', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-lemon-removal-stale-pending';
    const email = 'lemon-removal-stale@example.com';
    const discordUserId = 'discord-lemon-removal-stale-pending';
    const variantId = 'variant-lemon-removal-stale-pending';
    const sourceReference = 'lemonsqueezy:order:order-lemon-removal-stale-pending';
    const guildId = 'guild-lemon-removal-stale-pending';
    const roleId = 'role-lemon-removal-stale-pending';
    const { subjectId, providerConnectionId } = await seedLemonBuyer(t, {
      authUserId,
      email,
      discordUserId,
    });

    const { entitlementId, staleOutboxJobId } = await t.run(async (ctx) => {
      const guildLinkId = await ctx.db.insert('guild_links', {
        authUserId,
        discordGuildId: guildId,
        installedByAuthUserId: authUserId,
        botPresent: true,
        status: 'active',
        createdAt: 1_000,
        updatedAt: 1_000,
      });
      await ctx.db.insert('role_rules', {
        authUserId,
        guildId,
        guildLinkId,
        productId: variantId,
        verifiedRoleId: roleId,
        removeOnRevoke: true,
        priority: 0,
        enabled: true,
        createdAt: 1_000,
        updatedAt: 1_000,
      });
      const insertedEntitlementId = await ctx.db.insert('entitlements', {
        authUserId,
        subjectId,
        productId: variantId,
        sourceProvider: 'lemonsqueezy',
        sourceReference,
        status: 'active',
        policySnapshotVersion: 1,
        grantedAt: 1_000,
        updatedAt: 1_000,
      });
      const insertedStaleOutboxJobId = await ctx.db.insert('outbox_jobs', {
        authUserId,
        jobType: 'role_removal',
        payload: {
          subjectId,
          entitlementId: insertedEntitlementId,
          guildId,
          roleId,
          discordUserId,
        },
        status: 'pending',
        idempotencyKey: `role_removal:${authUserId}:${subjectId}:${guildId}:${variantId}:${roleId}`,
        targetGuildId: guildId,
        targetDiscordUserId: discordUserId,
        retryCount: 0,
        maxRetries: 10,
        createdAt: 1_500,
        updatedAt: 1_500,
      });
      return { entitlementId: insertedEntitlementId, staleOutboxJobId: insertedStaleOutboxJobId };
    });

    const payload = lemonOrderPayload({
      orderId: 'order-lemon-removal-stale-pending',
      email,
      variantId,
      eventName: 'order_refunded',
      refunded: true,
    });
    const webhookEventId = await seedLemonWebhookEvent(t, {
      authUserId,
      providerConnectionId,
      providerEventId: 'order-lemon-removal-stale-pending:order_refunded',
      eventType: 'order_refunded',
      payload,
    });

    vi.spyOn(Date, 'now').mockReturnValue(3_000);
    await t.run(async (ctx) =>
      processLemonEvent(
        ctx,
        authUserId,
        {
          _id: webhookEventId,
          providerConnectionId,
          eventType: 'order_refunded',
        },
        payload
      )
    );

    const roleRemovalRows = await t.run(async (ctx) =>
      ctx.db
        .query('outbox_jobs')
        .withIndex('by_auth_user_type', (q) =>
          q.eq('authUserId', authUserId).eq('jobType', 'role_removal')
        )
        .collect()
    );
    const freshRow = roleRemovalRows.find((row) => row._id !== staleOutboxJobId);

    expect(roleRemovalRows).toHaveLength(2);
    expect(freshRow?.idempotencyKey).toBe(
      `role_removal:${authUserId}:${subjectId}:${guildId}:${variantId}:${roleId}:${entitlementId}:revoke:3000`
    );
    expect((freshRow?.payload as { entitlementId?: string } | undefined)?.entitlementId).toBe(
      entitlementId
    );
  });

  it('warns and skips role removal rules missing a verified role id', async () => {
    const t = makeTestConvex();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const authUserId = 'auth-webhook-misconfigured-removal';
    const subjectId = 'subject-webhook-misconfigured-removal' as Id<'subjects'>;
    const productId = 'product-webhook-misconfigured-removal';
    const guildId = 'guild-webhook-misconfigured-removal';
    const now = 1_000;

    await t.run(async (ctx) => {
      const guildLinkId = await ctx.db.insert('guild_links', {
        authUserId,
        discordGuildId: guildId,
        installedByAuthUserId: authUserId,
        botPresent: true,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('role_rules', {
        authUserId,
        guildId,
        guildLinkId,
        productId,
        verifiedRoleId: '',
        removeOnRevoke: true,
        priority: 0,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    });

    await t.run(async (ctx) =>
      emitRoleRemovalJobs(ctx, authUserId, subjectId, productId, 'discord-webhook-removal')
    );

    const rows = await t.run(async (ctx) => ctx.db.query('outbox_jobs').collect());
    expect(rows).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      '[convex] Skipping role removal for misconfigured role rule',
      expect.objectContaining({
        authUserId,
        guildId,
        reason: 'missing_verified_role_id',
      })
    );
    expect(warnSpy.mock.calls[0]?.[1]).not.toHaveProperty('productId');
  });
});
