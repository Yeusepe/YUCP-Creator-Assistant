/**
 * Provider Connections - Creator credentials and webhook config
 *
 * Gumroad: OAuth tokens, resource subscriptions.
 * Jinxxy: API key, webhook secret.
 */

import { v } from 'convex/values';
import { providerLabel } from '../packages/shared/src/providers';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import {
  type ExternalAccountIdentityCandidate,
  findDuplicateExternalAccountIdentityGroups,
} from './lib/externalAccountIdentity';
import { ProviderV } from './lib/providers';

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

function getConnectionProviderKey(connection: {
  provider?: unknown;
  providerKey?: unknown;
}): string {
  const providerKey =
    typeof connection.providerKey === 'string'
      ? connection.providerKey
      : typeof connection.provider === 'string'
        ? connection.provider
        : 'unknown';
  return providerKey;
}

function getDefaultConnectionLabel(providerKey: string): string {
  return `${providerLabel(providerKey)} Connection`;
}

async function getCredentialValue(
  ctx: any,
  connectionId: Id<'provider_connections'>,
  credentialKey: string
): Promise<string | null> {
  const credential = await ctx.db
    .query('provider_credentials')
    .withIndex('by_connection_key', (q: any) =>
      q.eq('providerConnectionId', connectionId).eq('credentialKey', credentialKey)
    )
    .first();
  return credential?.encryptedValue ?? null;
}

async function upsertCredential(
  ctx: MutationCtx,
  args: {
    tenantId?: Id<'tenants'>;
    providerConnectionId: Id<'provider_connections'>;
    providerKey: string;
    credentialKey: string;
    kind:
      | 'api_key'
      | 'api_token'
      | 'oauth_access_token'
      | 'oauth_refresh_token'
      | 'webhook_secret'
      | 'remote_webhook'
      | 'store_selector';
    encryptedValue?: string;
    metadata?: unknown;
  }
): Promise<Id<'provider_credentials'>> {
  const now = Date.now();
  const existing = await ctx.db
    .query('provider_credentials')
    .withIndex('by_connection_key', (q) =>
      q
        .eq('providerConnectionId', args.providerConnectionId)
        .eq('credentialKey', args.credentialKey)
    )
    .first();

  if (existing) {
    await ctx.db.patch(existing._id, {
      status: 'active',
      encryptedValue: args.encryptedValue ?? existing.encryptedValue,
      metadata: args.metadata ?? existing.metadata,
      lastValidatedAt: now,
      updatedAt: now,
    });
    return existing._id;
  }

  return await ctx.db.insert('provider_credentials', {
    tenantId: args.tenantId,
    providerConnectionId: args.providerConnectionId,
    providerKey: args.providerKey as any,
    credentialKey: args.credentialKey,
    kind: args.kind,
    status: 'active',
    encryptedValue: args.encryptedValue,
    metadata: args.metadata,
    lastValidatedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

async function upsertCapability(
  ctx: MutationCtx,
  args: {
    tenantId?: Id<'tenants'>;
    providerConnectionId: Id<'provider_connections'>;
    providerKey: string;
    capabilityKey: string;
    status: 'pending' | 'available' | 'configured' | 'active' | 'degraded' | 'unsupported';
    requiredCredentialKeys?: string[];
    errorCode?: string;
    errorSummary?: string;
  }
): Promise<Id<'provider_connection_capabilities'>> {
  const now = Date.now();
  const existing = await ctx.db
    .query('provider_connection_capabilities')
    .withIndex('by_connection_capability', (q) =>
      q
        .eq('providerConnectionId', args.providerConnectionId)
        .eq('capabilityKey', args.capabilityKey)
    )
    .first();

  if (existing) {
    await ctx.db.patch(existing._id, {
      status: args.status,
      requiredCredentialKeys: args.requiredCredentialKeys ?? existing.requiredCredentialKeys,
      errorCode: args.errorCode,
      errorSummary: args.errorSummary,
      lastCheckedAt: now,
      updatedAt: now,
    });
    return existing._id;
  }

  return await ctx.db.insert('provider_connection_capabilities', {
    tenantId: args.tenantId,
    providerConnectionId: args.providerConnectionId,
    providerKey: args.providerKey as any,
    capabilityKey: args.capabilityKey,
    status: args.status,
    requiredCredentialKeys: args.requiredCredentialKeys ?? [],
    errorCode: args.errorCode,
    errorSummary: args.errorSummary,
    lastCheckedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

async function deleteExternalAccountIfOrphaned(
  ctx: MutationCtx,
  externalAccountId: Id<'external_accounts'>
): Promise<boolean> {
  const remainingBindings = await ctx.db
    .query('bindings')
    .withIndex('by_external_account', (q) => q.eq('externalAccountId', externalAccountId))
    .collect();

  if (remainingBindings.length > 0) {
    return false;
  }

  await ctx.db.delete(externalAccountId);
  return true;
}

async function getSubjectTenantExternalAccountCandidates(
  ctx: MutationCtx,
  tenantId: Id<'tenants'>,
  subjectId: Id<'subjects'>
): Promise<ExternalAccountIdentityCandidate[]> {
  const bindings = await ctx.db
    .query('bindings')
    .withIndex('by_tenant_subject', (q) => q.eq('tenantId', tenantId).eq('subjectId', subjectId))
    .collect();

  const candidates: ExternalAccountIdentityCandidate[] = [];
  for (const binding of bindings) {
    if (binding.status !== 'active') continue;

    const account = await ctx.db.get(binding.externalAccountId);
    if (!account || account.status !== 'active') continue;

    candidates.push({
      bindingCreatedAt: binding.createdAt,
      bindingId: String(binding._id),
      externalAccountCreatedAt: account.createdAt,
      externalAccountCreationTime: account._creationTime,
      externalAccountId: String(account._id),
      provider: account.provider,
      providerUserId: account.providerUserId,
    });
  }

  return candidates;
}

/**
 * Get Jinxxy webhook secret for a tenant.
 * Used by webhook handler for signature verification.
 */
export const getJinxxyWebhookSecret = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', 'jinxxy')
      )
      .first();
    if (!conn || conn.status === 'disconnected') return null;
    const credentialSecret = await getCredentialValue(ctx, conn._id, 'webhook_secret');
    return credentialSecret ?? conn.webhookSecretRef ?? null;
  },
});

/**
 * Get Gumroad webhook secret for a tenant.
 * Used by webhook handler for signature verification.
 */
export const getGumroadWebhookSecret = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', 'gumroad')
      )
      .first();
    if (!conn) return null;
    const credentialSecret = await getCredentialValue(ctx, conn._id, 'webhook_secret');
    return credentialSecret ?? conn.gumroadWebhookSecretRef ?? null;
  },
});

/**
 * Maps authMode (stored on each connection) to the corresponding credential key
 * in the provider_credentials table. Adding support for a new auth mode only
 * requires adding an entry here — no per-provider hardcoding needed.
 */
const AUTH_MODE_CREDENTIAL_KEY: Record<string, string> = {
  oauth: 'oauth_access_token',
  api_key: 'api_key',
  api_token: 'api_token',
};

/**
 * Get connection status for a tenant. Returns a dynamic record keyed by
 * provider name so new providers are automatically included without code changes.
 */
export const getConnectionStatus = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
  },
  returns: v.record(v.string(), v.boolean()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const connections = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant', (q) => q.eq('tenantId', args.tenantId))
      .collect();

    const result: Record<string, boolean> = {};
    await Promise.all(
      connections.map(async (conn) => {
        const providerKey = getConnectionProviderKey(conn);
        if (conn.status === 'disconnected') {
          result[providerKey] = false;
          return;
        }
        const credKey = conn.authMode ? AUTH_MODE_CREDENTIAL_KEY[conn.authMode] : undefined;
        const credValue = credKey ? await getCredentialValue(ctx, conn._id, credKey) : null;
        // Preserve backward compatibility for connections that predate the credentials table.
        const hasLegacyToken = !!(conn.gumroadAccessTokenEncrypted || conn.jinxxyApiKeyEncrypted);
        result[providerKey] = !!(credValue || hasLegacyToken);
      })
    );
    return result;
  },
});

/**
 * List all connections for a tenant with full status info.
 */
export const listConnections = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const tenant = await ctx.db.get(args.tenantId);
    const allowMismatchedEmails = tenant?.policy?.allowMismatchedEmails ?? false;

    const connections = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant', (q) => q.eq('tenantId', args.tenantId))
      .collect();

    return {
      allowMismatchedEmails,
      connections: await Promise.all(
        connections.map(async (c) => {
          const capabilityRows = await ctx.db
            .query('provider_connection_capabilities')
            .withIndex('by_connection', (q) => q.eq('providerConnectionId', c._id))
            .collect();
          const providerKey = getConnectionProviderKey(c);
          const apiKey = await getCredentialValue(ctx, c._id, 'api_key');
          const apiToken = await getCredentialValue(ctx, c._id, 'api_token');
          const accessToken = await getCredentialValue(ctx, c._id, 'oauth_access_token');

          return {
            id: c._id,
            provider: c.provider,
            providerKey,
            label: c.label ?? getDefaultConnectionLabel(providerKey),
            connectionType: c.connectionType ?? 'setup',
            status:
              c.status ??
              (c.gumroadAccessTokenEncrypted ||
              c.jinxxyApiKeyEncrypted ||
              apiKey ||
              apiToken ||
              accessToken
                ? 'active'
                : 'disconnected'),
            authMode: c.authMode,
            externalShopId: c.externalShopId,
            externalShopName: c.externalShopName,
            webhookConfigured: c.webhookConfigured,
            hasApiKey: !!(apiKey || c.jinxxyApiKeyEncrypted),
            hasApiToken: !!apiToken,
            hasAccessToken: !!(accessToken || c.gumroadAccessTokenEncrypted),
            capabilities: capabilityRows.map((row) => ({
              capabilityKey: row.capabilityKey,
              status: row.status,
              errorCode: row.errorCode,
              errorSummary: row.errorSummary,
            })),
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
          };
        })
      ),
    };
  },
});

export const getProviderConnection = query({
  args: {
    apiSecret: v.string(),
    connectionId: v.id('provider_connections'),
    tenantId: v.id('tenants'),
  },
  returns: v.union(
    v.null(),
    v.object({
      id: v.id('provider_connections'),
      provider: v.string(),
      providerKey: v.string(),
      label: v.string(),
      status: v.string(),
      authMode: v.optional(v.string()),
      externalShopId: v.optional(v.string()),
      externalShopName: v.optional(v.string()),
      webhookConfigured: v.boolean(),
      webhookEndpoint: v.optional(v.string()),
      remoteWebhookId: v.optional(v.string()),
      testMode: v.optional(v.boolean()),
      metadata: v.optional(v.any()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.tenantId !== args.tenantId) {
      return null;
    }

    const providerKey = getConnectionProviderKey(connection);
    return {
      id: connection._id,
      provider: connection.provider,
      providerKey,
      label: connection.label ?? getDefaultConnectionLabel(providerKey),
      status: connection.status ?? 'pending',
      authMode: connection.authMode,
      externalShopId: connection.externalShopId,
      externalShopName: connection.externalShopName,
      webhookConfigured: connection.webhookConfigured,
      webhookEndpoint: connection.webhookEndpoint,
      remoteWebhookId: connection.remoteWebhookId,
      testMode: connection.testMode,
      metadata: connection.metadata,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
  },
});

/**
 * Get connection with encrypted tokens for backfill (internal use by API).
 * Returns encrypted token for decryption by API which has BETTER_AUTH_SECRET.
 */
export const getConnectionForBackfill = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    provider: ProviderV,
  },
  returns: v.union(
    v.object({
      gumroadAccessTokenEncrypted: v.optional(v.string()),
      jinxxyApiKeyEncrypted: v.optional(v.string()),
      lemonApiTokenEncrypted: v.optional(v.string()),
      webhookSecretEncrypted: v.optional(v.string()),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', args.provider)
      )
      .first();

    if (conn) {
      const apiKey = await getCredentialValue(ctx, conn._id, 'api_key');
      const apiToken = await getCredentialValue(ctx, conn._id, 'api_token');
      const accessToken = await getCredentialValue(ctx, conn._id, 'oauth_access_token');
      const webhookSecret = await getCredentialValue(ctx, conn._id, 'webhook_secret');

      return {
        gumroadAccessTokenEncrypted: accessToken ?? conn.gumroadAccessTokenEncrypted,
        jinxxyApiKeyEncrypted: apiKey ?? conn.jinxxyApiKeyEncrypted,
        lemonApiTokenEncrypted: apiToken ?? undefined,
        webhookSecretEncrypted:
          webhookSecret ??
          conn.remoteWebhookSecretRef ??
          conn.webhookSecretRef ??
          conn.gumroadWebhookSecretRef,
      };
    }

    // Fall back to user-scoped connection for this tenant's owner
    const tenant = await ctx.db.get(args.tenantId);
    if (!tenant?.ownerAuthUserId) return null;
    const ownerAuthUserId = tenant.ownerAuthUserId;

    const userConn = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', ownerAuthUserId).eq('provider', args.provider)
      )
      .first();

    if (!userConn) return null;
    return {
      gumroadAccessTokenEncrypted: userConn.gumroadAccessTokenEncrypted,
      jinxxyApiKeyEncrypted: userConn.jinxxyApiKeyEncrypted,
    };
  },
});

export const createProviderConnection = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    providerKey: ProviderV,
    label: v.optional(v.string()),
    authMode: v.optional(v.string()),
    externalShopId: v.optional(v.string()),
    externalShopName: v.optional(v.string()),
    installedBySubjectId: v.optional(v.id('subjects')),
    metadata: v.optional(v.any()),
  },
  returns: v.id('provider_connections'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const existing = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', args.providerKey)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        providerKey: args.providerKey,
        label: args.label ?? existing.label,
        authMode: args.authMode ?? existing.authMode,
        externalShopId: args.externalShopId ?? existing.externalShopId,
        externalShopName: args.externalShopName ?? existing.externalShopName,
        installedBySubjectId: args.installedBySubjectId ?? existing.installedBySubjectId,
        metadata: args.metadata ?? existing.metadata,
        status: existing.status ?? 'pending',
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert('provider_connections', {
      tenantId: args.tenantId,
      provider: args.providerKey,
      providerKey: args.providerKey,
      label: args.label ?? getDefaultConnectionLabel(args.providerKey),
      connectionType: 'setup',
      status: 'pending',
      authMode: args.authMode,
      externalShopId: args.externalShopId,
      externalShopName: args.externalShopName,
      installedBySubjectId: args.installedBySubjectId,
      webhookConfigured: false,
      metadata: args.metadata,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const putProviderCredential = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    providerConnectionId: v.id('provider_connections'),
    credentialKey: v.string(),
    kind: v.union(
      v.literal('api_key'),
      v.literal('api_token'),
      v.literal('oauth_access_token'),
      v.literal('oauth_refresh_token'),
      v.literal('webhook_secret'),
      v.literal('remote_webhook'),
      v.literal('store_selector')
    ),
    encryptedValue: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  returns: v.id('provider_credentials'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const connection = await ctx.db.get(args.providerConnectionId);
    if (!connection || connection.tenantId !== args.tenantId) {
      throw new Error('Connection not found or access denied');
    }

    const providerKey = getConnectionProviderKey(connection);
    const credentialId = await upsertCredential(ctx, {
      tenantId: args.tenantId,
      providerConnectionId: args.providerConnectionId,
      providerKey,
      credentialKey: args.credentialKey,
      kind: args.kind,
      encryptedValue: args.encryptedValue,
      metadata: args.metadata,
    });

    await ctx.db.patch(args.providerConnectionId, {
      providerKey,
      status: 'active',
      updatedAt: Date.now(),
    });

    return credentialId;
  },
});

export const upsertConnectionCapability = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    providerConnectionId: v.id('provider_connections'),
    capabilityKey: v.string(),
    status: v.union(
      v.literal('pending'),
      v.literal('available'),
      v.literal('configured'),
      v.literal('active'),
      v.literal('degraded'),
      v.literal('unsupported')
    ),
    requiredCredentialKeys: v.optional(v.array(v.string())),
    errorCode: v.optional(v.string()),
    errorSummary: v.optional(v.string()),
  },
  returns: v.id('provider_connection_capabilities'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const connection = await ctx.db.get(args.providerConnectionId);
    if (!connection || connection.tenantId !== args.tenantId) {
      throw new Error('Connection not found or access denied');
    }

    return await upsertCapability(ctx, {
      tenantId: args.tenantId,
      providerConnectionId: args.providerConnectionId,
      providerKey: getConnectionProviderKey(connection),
      capabilityKey: args.capabilityKey,
      status: args.status,
      requiredCredentialKeys: args.requiredCredentialKeys,
      errorCode: args.errorCode,
      errorSummary: args.errorSummary,
    });
  },
});

/**
 * Disconnect a provider connection (soft delete - sets status to 'disconnected').
 * Access is checked via authUserId (preferred) or tenantId (legacy).
 */
export const disconnectConnection = mutation({
  args: {
    apiSecret: v.string(),
    connectionId: v.id('provider_connections'),
    tenantId: v.optional(v.id('tenants')),
    authUserId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    if (!args.tenantId && !args.authUserId) {
      throw new Error('Either tenantId or authUserId must be provided');
    }
    const conn = await ctx.db.get(args.connectionId);
    if (!conn) throw new Error('Connection not found');
    const ownedByTenant = args.tenantId && conn.tenantId === args.tenantId;
    const ownedByUser = args.authUserId && conn.authUserId === args.authUserId;
    if (!ownedByTenant && !ownedByUser) {
      throw new Error('Connection not found or access denied');
    }
    await ctx.db.patch(args.connectionId, {
      status: 'disconnected',
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

/**
 * Update a specific tenant setting from the onboarding flow.
 */
export const updateTenantSetting = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    key: v.string(),
    value: v.any(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const tenant = await ctx.db.get(args.tenantId);
    if (!tenant) throw new Error('Tenant not found');

    const policy = tenant.policy ?? {};
    const updatedPolicy = { ...policy, [args.key]: args.value };

    await ctx.db.patch(args.tenantId, {
      policy: updatedPolicy,
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

/**
 * Upsert Gumroad provider connection (OAuth tokens).
 * tenantId is optional — omit when creating a user-scoped personal connection.
 */
export const upsertGumroadConnection = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.optional(v.id('tenants')),
    authUserId: v.optional(v.string()),
    gumroadAccessTokenEncrypted: v.string(),
    gumroadRefreshTokenEncrypted: v.optional(v.string()),
    gumroadUserId: v.optional(v.string()),
  },
  returns: v.id('provider_connections'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    if (!args.tenantId && !args.authUserId) {
      throw new Error('Either tenantId or authUserId must be provided');
    }
    const now = Date.now();

    // Look up existing connection by the most specific scope available.
    const tenantId = args.tenantId;
    const authUserId = args.authUserId;
    let existing = tenantId
      ? await ctx.db
          .query('provider_connections')
          .withIndex('by_tenant_provider', (q) =>
            q.eq('tenantId', tenantId).eq('provider', 'gumroad')
          )
          .first()
      : null;

    if (!existing && authUserId) {
      existing = await ctx.db
        .query('provider_connections')
        .withIndex('by_auth_user_provider', (q) =>
          q.eq('authUserId', authUserId).eq('provider', 'gumroad')
        )
        .filter((q) => q.eq(q.field('tenantId'), undefined))
        .first();
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        providerKey: 'gumroad',
        status: 'active',
        authMode: 'oauth',
        gumroadAccessTokenEncrypted: args.gumroadAccessTokenEncrypted,
        gumroadRefreshTokenEncrypted:
          args.gumroadRefreshTokenEncrypted ?? existing.gumroadRefreshTokenEncrypted,
        gumroadUserId: args.gumroadUserId ?? existing.gumroadUserId,
        authUserId: args.authUserId ?? existing.authUserId,
        updatedAt: now,
      });
      await upsertCredential(ctx, {
        tenantId: args.tenantId,
        providerConnectionId: existing._id,
        providerKey: 'gumroad',
        credentialKey: 'oauth_access_token',
        kind: 'oauth_access_token',
        encryptedValue: args.gumroadAccessTokenEncrypted,
      });
      if (args.gumroadRefreshTokenEncrypted) {
        await upsertCredential(ctx, {
          tenantId: args.tenantId,
          providerConnectionId: existing._id,
          providerKey: 'gumroad',
          credentialKey: 'oauth_refresh_token',
          kind: 'oauth_refresh_token',
          encryptedValue: args.gumroadRefreshTokenEncrypted,
        });
      }
      await upsertCapability(ctx, {
        tenantId: args.tenantId,
        providerConnectionId: existing._id,
        providerKey: 'gumroad',
        capabilityKey: 'account_link',
        status: 'active',
      });
      return existing._id;
    }

    const connectionId = await ctx.db.insert('provider_connections', {
      tenantId: args.tenantId,
      authUserId: args.authUserId,
      provider: 'gumroad',
      providerKey: 'gumroad',
      label: 'Gumroad Store',
      connectionType: 'setup',
      status: 'active',
      authMode: 'oauth',
      gumroadAccessTokenEncrypted: args.gumroadAccessTokenEncrypted,
      gumroadRefreshTokenEncrypted: args.gumroadRefreshTokenEncrypted,
      gumroadUserId: args.gumroadUserId,
      webhookConfigured: false,
      createdAt: now,
      updatedAt: now,
    });
    await upsertCredential(ctx, {
      tenantId: args.tenantId,
      providerConnectionId: connectionId,
      providerKey: 'gumroad',
      credentialKey: 'oauth_access_token',
      kind: 'oauth_access_token',
      encryptedValue: args.gumroadAccessTokenEncrypted,
    });
    if (args.gumroadRefreshTokenEncrypted) {
      await upsertCredential(ctx, {
        tenantId: args.tenantId,
        providerConnectionId: connectionId,
        providerKey: 'gumroad',
        credentialKey: 'oauth_refresh_token',
        kind: 'oauth_refresh_token',
        encryptedValue: args.gumroadRefreshTokenEncrypted,
      });
    }
    await upsertCapability(ctx, {
      tenantId: args.tenantId,
      providerConnectionId: connectionId,
      providerKey: 'gumroad',
      capabilityKey: 'account_link',
      status: 'active',
    });
    return connectionId;
  },
});

/**
 * Upsert Jinxxy provider connection (API key, webhook secret).
 * tenantId is optional — omit when creating a user-scoped personal connection.
 */
export const upsertJinxxyConnection = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.optional(v.id('tenants')),
    authUserId: v.optional(v.string()),
    jinxxyApiKeyEncrypted: v.optional(v.string()),
    webhookSecretRef: v.optional(v.string()),
    webhookEndpoint: v.optional(v.string()),
  },
  returns: v.id('provider_connections'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    if (!args.tenantId && !args.authUserId) {
      throw new Error('Either tenantId or authUserId must be provided');
    }
    const now = Date.now();

    const tenantId = args.tenantId;
    const authUserId = args.authUserId;
    let existing = tenantId
      ? await ctx.db
          .query('provider_connections')
          .withIndex('by_tenant_provider', (q) =>
            q.eq('tenantId', tenantId).eq('provider', 'jinxxy')
          )
          .first()
      : null;

    if (!existing && authUserId) {
      existing = await ctx.db
        .query('provider_connections')
        .withIndex('by_auth_user_provider', (q) =>
          q.eq('authUserId', authUserId).eq('provider', 'jinxxy')
        )
        .filter((q) => q.eq(q.field('tenantId'), undefined))
        .first();
    }

    const webhookConfigured = !!(args.webhookSecretRef && args.webhookEndpoint);

    if (existing) {
      await ctx.db.patch(existing._id, {
        providerKey: 'jinxxy',
        status: 'active',
        authMode: 'api_key',
        jinxxyApiKeyEncrypted: args.jinxxyApiKeyEncrypted ?? existing.jinxxyApiKeyEncrypted,
        webhookSecretRef: args.webhookSecretRef ?? existing.webhookSecretRef,
        webhookEndpoint: args.webhookEndpoint ?? existing.webhookEndpoint,
        webhookConfigured: webhookConfigured || existing.webhookConfigured,
        authUserId: args.authUserId ?? existing.authUserId,
        updatedAt: now,
      });
      if (args.jinxxyApiKeyEncrypted) {
        await upsertCredential(ctx, {
          tenantId: args.tenantId,
          providerConnectionId: existing._id,
          providerKey: 'jinxxy',
          credentialKey: 'api_key',
          kind: 'api_key',
          encryptedValue: args.jinxxyApiKeyEncrypted,
        });
      }
      if (args.webhookSecretRef) {
        await upsertCredential(ctx, {
          tenantId: args.tenantId,
          providerConnectionId: existing._id,
          providerKey: 'jinxxy',
          credentialKey: 'webhook_secret',
          kind: 'webhook_secret',
          encryptedValue: args.webhookSecretRef,
        });
      }
      await upsertCapability(ctx, {
        tenantId: args.tenantId,
        providerConnectionId: existing._id,
        providerKey: 'jinxxy',
        capabilityKey: 'catalog_sync',
        status: args.jinxxyApiKeyEncrypted ? 'configured' : 'pending',
        requiredCredentialKeys: ['api_key'],
      });
      await upsertCapability(ctx, {
        tenantId: args.tenantId,
        providerConnectionId: existing._id,
        providerKey: 'jinxxy',
        capabilityKey: 'webhooks',
        status: webhookConfigured ? 'configured' : 'pending',
        requiredCredentialKeys: ['webhook_secret'],
      });
      return existing._id;
    }

    const connectionId = await ctx.db.insert('provider_connections', {
      tenantId: args.tenantId,
      authUserId: args.authUserId,
      provider: 'jinxxy',
      providerKey: 'jinxxy',
      label: 'Jinxxy Store',
      connectionType: 'setup',
      status: 'active',
      authMode: 'api_key',
      jinxxyApiKeyEncrypted: args.jinxxyApiKeyEncrypted,
      webhookSecretRef: args.webhookSecretRef,
      webhookEndpoint: args.webhookEndpoint,
      webhookConfigured,
      createdAt: now,
      updatedAt: now,
    });
    if (args.jinxxyApiKeyEncrypted) {
      await upsertCredential(ctx, {
        tenantId: args.tenantId,
        providerConnectionId: connectionId,
        providerKey: 'jinxxy',
        credentialKey: 'api_key',
        kind: 'api_key',
        encryptedValue: args.jinxxyApiKeyEncrypted,
      });
    }
    if (args.webhookSecretRef) {
      await upsertCredential(ctx, {
        tenantId: args.tenantId,
        providerConnectionId: connectionId,
        providerKey: 'jinxxy',
        credentialKey: 'webhook_secret',
        kind: 'webhook_secret',
        encryptedValue: args.webhookSecretRef,
      });
    }
    await upsertCapability(ctx, {
      tenantId: args.tenantId,
      providerConnectionId: connectionId,
      providerKey: 'jinxxy',
      capabilityKey: 'catalog_sync',
      status: args.jinxxyApiKeyEncrypted ? 'configured' : 'pending',
      requiredCredentialKeys: ['api_key'],
    });
    await upsertCapability(ctx, {
      tenantId: args.tenantId,
      providerConnectionId: connectionId,
      providerKey: 'jinxxy',
      capabilityKey: 'webhooks',
      status: webhookConfigured ? 'configured' : 'pending',
      requiredCredentialKeys: ['webhook_secret'],
    });
    return connectionId;
  },
});

export const removeAccountForSubject = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    subjectId: v.id('subjects'),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const bindings = await ctx.db
      .query('bindings')
      .withIndex('by_tenant_subject', (q) =>
        q.eq('tenantId', args.tenantId).eq('subjectId', args.subjectId)
      )
      .collect();

    const accountIdsToDelete = new Set<Id<'external_accounts'>>();
    const bindingIdsToDelete: Id<'bindings'>[] = [];
    for (const binding of bindings) {
      const account = await ctx.db.get(binding.externalAccountId);
      if (account && account.provider === args.provider) {
        bindingIdsToDelete.push(binding._id);
        accountIdsToDelete.add(account._id);
      }
    }

    if (bindingIdsToDelete.length === 0) return false;

    for (const bindingId of bindingIdsToDelete) {
      await ctx.db.delete(bindingId);
    }

    for (const accountId of accountIdsToDelete) {
      await deleteExternalAccountIfOrphaned(ctx, accountId);
    }

    return true;
  },
});

export const cleanupDuplicateAccountsForSubject = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    subjectId: v.id('subjects'),
  },
  returns: v.object({
    duplicateGroups: v.number(),
    removedBindings: v.number(),
    removedExternalAccounts: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const candidates = await getSubjectTenantExternalAccountCandidates(
      ctx,
      args.tenantId,
      args.subjectId
    );
    const duplicateGroups = findDuplicateExternalAccountIdentityGroups(candidates);

    let removedBindings = 0;
    let removedExternalAccounts = 0;

    for (const group of duplicateGroups) {
      for (const duplicate of group.duplicates) {
        await ctx.db.delete(duplicate.bindingId as Id<'bindings'>);
        removedBindings += 1;

        if (
          await deleteExternalAccountIfOrphaned(
            ctx,
            duplicate.externalAccountId as Id<'external_accounts'>
          )
        ) {
          removedExternalAccounts += 1;
        }
      }
    }

    return {
      duplicateGroups: duplicateGroups.length,
      removedBindings,
      removedExternalAccounts,
    };
  },
});

// ============================================================================
// PAYHIP CONNECTION HELPERS
// ============================================================================

/**
 * Get the encrypted Payhip API key for a tenant.
 * Used by the webhook handler to verify the SHA-256 signature.
 * The caller (webhook handler) decrypts the value.
 *
 * Payhip webhook signature = SHA256(apiKey). No separate webhook secret is needed.
 */
export const getPayhipApiKey = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', 'payhip')
      )
      .first();
    if (!conn || conn.status === 'disconnected') return null;
    return getCredentialValue(ctx, conn._id, 'api_key');
  },
});

// ============================================================================
// USER-SCOPED QUERIES (no tenantId required)
// ============================================================================

const ConnectionSummaryV = v.object({
  id: v.id('provider_connections'),
  provider: v.string(),
  label: v.string(),
  connectionType: v.string(),
  status: v.string(),
  webhookConfigured: v.boolean(),
  hasApiKey: v.boolean(),
  hasAccessToken: v.boolean(),
  authUserId: v.optional(v.string()),
  tenantId: v.optional(v.id('tenants')),
  createdAt: v.number(),
  updatedAt: v.number(),
});

/**
 * List all active connections for a user, regardless of tenant scope.
 * Returns user-scoped connections plus legacy tenant-scoped connections
 * for tenants owned by this user.
 */
export const listConnectionsForUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.array(ConnectionSummaryV),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    // Direct user-scoped connections
    const userConnections = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.neq(q.field('status'), 'disconnected'))
      .collect();

    // Legacy tenant-scoped connections (pre-migration, no authUserId set)
    const ownedTenants = await ctx.db
      .query('tenants')
      .filter((q) => q.eq(q.field('ownerAuthUserId'), args.authUserId))
      .collect();

    const legacyConnections = [];
    for (const tenant of ownedTenants) {
      const tenantConns = await ctx.db
        .query('provider_connections')
        .withIndex('by_tenant', (q) => q.eq('tenantId', tenant._id))
        .filter((q) =>
          q.and(q.neq(q.field('status'), 'disconnected'), q.eq(q.field('authUserId'), undefined))
        )
        .collect();
      legacyConnections.push(...tenantConns);
    }

    const allConnections = [...userConnections, ...legacyConnections];

    return allConnections.map((c) => ({
      id: c._id,
      provider: c.provider,
      label: c.label ?? (c.provider === 'gumroad' ? 'Gumroad Store' : 'Jinxxy Store'),
      connectionType: c.connectionType ?? 'setup',
      status:
        c.status ??
        (c.gumroadAccessTokenEncrypted || c.jinxxyApiKeyEncrypted ? 'active' : 'disconnected'),
      webhookConfigured: c.webhookConfigured,
      hasApiKey: !!c.jinxxyApiKeyEncrypted,
      hasAccessToken: !!c.gumroadAccessTokenEncrypted,
      authUserId: c.authUserId,
      tenantId: c.tenantId,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  },
});

/**
 * Get all per-product secret keys stored for this tenant's Payhip connection.
 * Returns an array of { permalink, encryptedSecretKey } objects.
 * Credential keys follow the pattern: `product_key:{permalink}`
 */
export const getPayhipProductSecretKeys = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
  },
  returns: v.array(
    v.object({
      permalink: v.string(),
      encryptedSecretKey: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', 'payhip')
      )
      .first();
    if (!conn || conn.status === 'disconnected') return [];

    const credentials = await ctx.db
      .query('provider_credentials')
      .withIndex('by_connection', (q) => q.eq('providerConnectionId', conn._id))
      .collect();

    const results: { permalink: string; encryptedSecretKey: string }[] = [];
    for (const cred of credentials) {
      if (cred.credentialKey.startsWith('product_key:') && cred.encryptedValue) {
        const permalink = cred.credentialKey.slice('product_key:'.length);
        results.push({ permalink, encryptedSecretKey: cred.encryptedValue });
      }
    }
    return results;
  },
});

/**
 * Create or update the Payhip provider connection for a tenant.
 * Stores the encrypted API key. Called from the connect route after the creator
 * enters their Payhip API key.
 */
export const upsertPayhipConnection = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    encryptedApiKey: v.string(),
    label: v.optional(v.string()),
  },
  returns: v.object({
    connectionId: v.id('provider_connections'),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    let conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', 'payhip')
      )
      .first();

    const connectionLabel = args.label ?? 'Payhip Connection';

    if (conn) {
      await ctx.db.patch(conn._id, {
        status: 'active',
        label: connectionLabel,
        updatedAt: now,
      });
    } else {
      const id = await ctx.db.insert('provider_connections', {
        tenantId: args.tenantId,
        provider: 'payhip' as any,
        providerKey: 'payhip' as any,
        label: connectionLabel,
        connectionType: 'setup',
        status: 'active',
        authMode: 'api_key',
        webhookConfigured: false,
        createdAt: now,
        updatedAt: now,
      });
      conn = await ctx.db.get(id);
      if (!conn) throw new Error('Failed to create Payhip connection');
    }

    await upsertCredential(ctx, {
      tenantId: args.tenantId,
      providerConnectionId: conn._id,
      providerKey: 'payhip',
      credentialKey: 'api_key',
      kind: 'api_key',
      encryptedValue: args.encryptedApiKey,
    });

    await upsertCapability(ctx, {
      tenantId: args.tenantId,
      providerConnectionId: conn._id,
      providerKey: 'payhip',
      capabilityKey: 'webhooks',
      status: 'configured',
      requiredCredentialKeys: ['api_key'],
    });

    await upsertCapability(ctx, {
      tenantId: args.tenantId,
      providerConnectionId: conn._id,
      providerKey: 'payhip',
      capabilityKey: 'license_verification',
      status: 'pending',
      requiredCredentialKeys: [],
    });

    return { connectionId: conn._id };
  },
});

/**
 * Store or update a per-product secret key for Payhip license verification.
 * Credential key format: `product_key:{permalink}` (e.g., `product_key:RGsF`).
 * Called when the creator adds a new Payhip product mapping.
 */
export const upsertPayhipProductSecretKey = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    /** Product permalink from Payhip (e.g., "RGsF") */
    productPermalink: v.string(),
    /** Encrypted product-secret-key value */
    encryptedSecretKey: v.string(),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', 'payhip')
      )
      .first();

    if (!conn) {
      throw new Error('Payhip connection not found. Connect Payhip first.');
    }

    await upsertCredential(ctx, {
      tenantId: args.tenantId,
      providerConnectionId: conn._id,
      providerKey: 'payhip',
      credentialKey: `product_key:${args.productPermalink}`,
      kind: 'api_key',
      encryptedValue: args.encryptedSecretKey,
      metadata: { productPermalink: args.productPermalink },
    });

    // Once at least one product key is configured, mark license_verification as active.
    await upsertCapability(ctx, {
      tenantId: args.tenantId,
      providerConnectionId: conn._id,
      providerKey: 'payhip',
      capabilityKey: 'license_verification',
      status: 'active',
      requiredCredentialKeys: [`product_key:${args.productPermalink}`],
    });

    return { success: true };
  },
});

/**
 * Get all Payhip products known for a tenant.
 *
 * Merges two sources:
 * 1. `provider_credentials` entries with key `product_key:{permalink}` — manually added at setup
 *    time, available before any webhooks fire.
 * 2. `provider_catalog_mappings` entries upserted from webhook events — carry human-readable
 *    product names discovered from real purchases.
 *
 * Returns a deduplicated list keyed by permalink. The `hasSecretKey` flag indicates whether
 * the creator has configured the per-product secret key required for license verification.
 */
export const getPayhipProducts = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
  },
  returns: v.array(
    v.object({
      permalink: v.string(),
      displayName: v.optional(v.string()),
      productPermalink: v.optional(v.string()),
      hasSecretKey: v.boolean(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', 'payhip')
      )
      .first();

    if (!conn) return [];

    // Source 1: manually added product-secret-keys
    const credentials = await ctx.db
      .query('provider_credentials')
      .withIndex('by_connection', (q) => q.eq('providerConnectionId', conn._id))
      .collect();

    const credentialPermalinks = new Map<string, boolean>();
    for (const cred of credentials) {
      if (cred.credentialKey?.startsWith('product_key:')) {
        const permalink = cred.credentialKey.slice('product_key:'.length);
        if (permalink) credentialPermalinks.set(permalink, true);
      }
    }

    // Source 2: catalog mappings upserted from webhook events
    const catalogMappings = await ctx.db
      .query('provider_catalog_mappings')
      .withIndex('by_connection', (q) => q.eq('providerConnectionId', conn._id))
      .collect();

    const catalogByPermalink = new Map<
      string,
      { displayName?: string; productPermalink?: string }
    >();
    for (const m of catalogMappings) {
      if (m.externalProductId) {
        catalogByPermalink.set(m.externalProductId, {
          displayName: m.displayName,
          productPermalink: (m.metadata as any)?.productPermalink,
        });
      }
    }

    // Merge: union of both sets
    const allPermalinks = new Set([...credentialPermalinks.keys(), ...catalogByPermalink.keys()]);

    return Array.from(allPermalinks).map((permalink) => {
      const catalog = catalogByPermalink.get(permalink);
      return {
        permalink,
        displayName: catalog?.displayName,
        productPermalink: catalog?.productPermalink,
        hasSecretKey: credentialPermalinks.has(permalink),
      };
    });
  },
});

/**
 * Get connection status for a user across all providers.
 * Checks user-scoped connections and falls back to legacy tenant-scoped ones.
 */
export const getConnectionStatusForUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.object({ gumroad: v.boolean(), jinxxy: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const [gumroadUser, jinxxyUser] = await Promise.all([
      ctx.db
        .query('provider_connections')
        .withIndex('by_auth_user_provider', (q) =>
          q.eq('authUserId', args.authUserId).eq('provider', 'gumroad')
        )
        .filter((q) => q.neq(q.field('status'), 'disconnected'))
        .first(),
      ctx.db
        .query('provider_connections')
        .withIndex('by_auth_user_provider', (q) =>
          q.eq('authUserId', args.authUserId).eq('provider', 'jinxxy')
        )
        .filter((q) => q.neq(q.field('status'), 'disconnected'))
        .first(),
    ]);

    let hasGumroad = !!gumroadUser?.gumroadAccessTokenEncrypted;
    let hasJinxxy = !!jinxxyUser?.jinxxyApiKeyEncrypted;

    if (hasGumroad && hasJinxxy) return { gumroad: hasGumroad, jinxxy: hasJinxxy };

    // Fall back to legacy tenant-scoped lookup for unmigrated connections
    const ownedTenants = await ctx.db
      .query('tenants')
      .filter((q) => q.eq(q.field('ownerAuthUserId'), args.authUserId))
      .collect();

    for (const tenant of ownedTenants) {
      if (hasGumroad && hasJinxxy) break;
      if (!hasGumroad) {
        const g = await ctx.db
          .query('provider_connections')
          .withIndex('by_tenant_provider', (q) =>
            q.eq('tenantId', tenant._id).eq('provider', 'gumroad')
          )
          .filter((q) =>
            q.and(q.neq(q.field('status'), 'disconnected'), q.eq(q.field('authUserId'), undefined))
          )
          .first();
        if (g?.gumroadAccessTokenEncrypted) hasGumroad = true;
      }
      if (!hasJinxxy) {
        const j = await ctx.db
          .query('provider_connections')
          .withIndex('by_tenant_provider', (q) =>
            q.eq('tenantId', tenant._id).eq('provider', 'jinxxy')
          )
          .filter((q) =>
            q.and(q.neq(q.field('status'), 'disconnected'), q.eq(q.field('authUserId'), undefined))
          )
          .first();
        if (j?.jinxxyApiKeyEncrypted) hasJinxxy = true;
      }
    }

    return { gumroad: hasGumroad, jinxxy: hasJinxxy };
  },
});

/**
 * Mark the Payhip webhook as configured (called after first successful webhook delivery).
 */
export const markPayhipWebhookConfigured = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', 'payhip')
      )
      .first();

    if (conn && !conn.webhookConfigured) {
      await ctx.db.patch(conn._id, { webhookConfigured: true, updatedAt: Date.now() });
    }
    return null;
  },
});

/**
 * Data migration: backfill authUserId on existing tenant-scoped connections.
 * Idempotent — safe to run multiple times. Processes up to batchSize per call.
 */
export const backfillConnectionAuthUserId = mutation({
  args: {
    apiSecret: v.string(),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({ processed: v.number(), skipped: v.number(), remaining: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const limit = args.batchSize ?? 50;

    const connections = await ctx.db
      .query('provider_connections')
      .filter((q) => q.eq(q.field('authUserId'), undefined))
      .take(limit + 1);

    const remaining = connections.length > limit;
    const batch = connections.slice(0, limit);

    let processed = 0;
    let skipped = 0;

    for (const conn of batch) {
      if (!conn.tenantId) {
        skipped++;
        continue;
      }
      const tenant = await ctx.db.get(conn.tenantId);
      if (!tenant?.ownerAuthUserId) {
        skipped++;
        continue;
      }
      await ctx.db.patch(conn._id, { authUserId: tenant.ownerAuthUserId });
      processed++;
    }

    return { processed, skipped, remaining };
  },
});
