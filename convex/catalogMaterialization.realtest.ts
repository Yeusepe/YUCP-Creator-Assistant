import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from './_generated/api';
import { makeTestConvex } from './testHelpers';

const API_SECRET = 'test-secret';

describe('catalog materialization triggers', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
  });

  it('enqueues catalog materialization when a catalog provider store connects', async () => {
    const t = makeTestConvex();
    const authUserId = 'creator-owner-store-materialization';

    const connectionId = await t.mutation(api.providerConnections.upsertProviderConnection, {
      apiSecret: API_SECRET,
      authUserId,
      providerKey: 'gumroad',
      authMode: 'oauth',
      credentials: [
        {
          credentialKey: 'oauth_access_token',
          kind: 'oauth_access_token',
          encryptedValue: 'encrypted-owner-access-token',
        },
      ],
      capabilities: [
        {
          capabilityKey: 'catalog_sync',
          status: 'active',
          requiredCredentialKeys: ['oauth_access_token'],
        },
      ],
    });

    const jobs = await t.run((ctx) =>
      ctx.db
        .query('outbox_jobs')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
        .collect()
    );

    expect(jobs).toEqual([
      expect.objectContaining({
        authUserId,
        jobType: 'catalog_materialization',
        payload: {
          provider: 'gumroad',
          sourceConnectionId: connectionId,
          sourceKind: 'owner',
        },
        status: 'pending',
      }),
    ]);
  });

  it('enqueues catalog materialization when a collaborator store connects', async () => {
    const t = makeTestConvex();
    const ownerAuthUserId = 'creator-collaborator-store-materialization';
    const inviteId = await t.mutation(api.collaboratorInvites.createCollaboratorInvite, {
      apiSecret: API_SECRET,
      ownerAuthUserId,
      ownerDisplayName: 'Creator without a store',
      tokenHash: 'collaborator-materialization-token-hash',
      expiresAt: Date.now() + 60_000,
      providerKey: 'jinxxy',
    });

    const connectionId = await t.mutation(api.collaboratorInvites.acceptCollaboratorInvite, {
      apiSecret: API_SECRET,
      inviteId,
      credentialEncrypted: 'encrypted-collaborator-api-key',
      linkType: 'account',
      provider: 'jinxxy',
      collaboratorDiscordUserId: 'discord-collaborator-materialization',
      collaboratorDisplayName: 'Shared Store',
    });

    const jobs = await t.run((ctx) =>
      ctx.db
        .query('outbox_jobs')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', ownerAuthUserId))
        .collect()
    );

    expect(jobs).toEqual([
      expect.objectContaining({
        authUserId: ownerAuthUserId,
        jobType: 'catalog_materialization',
        payload: {
          provider: 'jinxxy',
          sourceConnectionId: connectionId,
          sourceKind: 'collaborator',
        },
        status: 'pending',
      }),
    ]);
  });

  it('repairs active owner and collaborator stores that predate automatic materialization', async () => {
    vi.useFakeTimers();
    const t = makeTestConvex();
    const now = Date.now();
    const ownerAuthUserId = 'creator-existing-catalog-connections';

    const sourceIds = await t.run(async (ctx) => {
      const ownerConnectionId = await ctx.db.insert('provider_connections', {
        authUserId: ownerAuthUserId,
        provider: 'gumroad',
        providerKey: 'gumroad',
        label: 'Existing Gumroad Store',
        connectionType: 'setup',
        status: 'active',
        authMode: 'oauth',
        webhookConfigured: false,
        createdAt: now,
        updatedAt: now,
      });
      const collaboratorConnectionId = await ctx.db.insert('collaborator_connections', {
        ownerAuthUserId,
        provider: 'jinxxy',
        credentialEncrypted: 'encrypted-existing-collaborator-key',
        webhookConfigured: false,
        linkType: 'account',
        status: 'active',
        collaboratorDiscordUserId: 'discord-existing-collaborator',
        collaboratorDisplayName: 'Existing Shared Store',
        source: 'invite',
        createdAt: now,
        updatedAt: now,
      });
      return { collaboratorConnectionId, ownerConnectionId };
    });

    const catalogMaterialization = (
      internal as unknown as {
        catalogMaterialization: {
          reconcileActiveConnections: unknown;
        };
      }
    ).catalogMaterialization;
    try {
      await t.run((ctx) =>
        ctx.runMutation(catalogMaterialization.reconcileActiveConnections as never, {})
      );
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    const jobs = await t.run((ctx) =>
      ctx.db
        .query('outbox_jobs')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', ownerAuthUserId))
        .collect()
    );

    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey: expect.stringContaining(String(sourceIds.ownerConnectionId)),
          jobType: 'catalog_materialization',
        }),
        expect.objectContaining({
          idempotencyKey: expect.stringContaining(String(sourceIds.collaboratorConnectionId)),
          jobType: 'catalog_materialization',
        }),
      ])
    );
  });
});
