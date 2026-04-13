/**
 * Provider Connections - Creator credentials and webhook config
 *
 * All credentials are stored generically in the provider_credentials table.
 * No per-provider field names are needed here.
 */

import { providerLabel } from '@yucp/providers/providerMetadata';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import { AUTH_MODE_CREDENTIAL_KEY } from './lib/credentialKeys';
import {
  type ExternalAccountIdentityCandidate,
  findDuplicateExternalAccountIdentityGroups,
} from './lib/externalAccountIdentity';
import { ProviderV } from './lib/providers';

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
  authUserId: string,
  subjectId: Id<'subjects'>
): Promise<ExternalAccountIdentityCandidate[]> {
  const bindings = await ctx.db
    .query('bindings')
    .withIndex('by_auth_user_subject', (q) =>
      q.eq('authUserId', authUserId).eq('subjectId', subjectId)
    )
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
    authUserId: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.authUserId).eq('provider', 'jinxxy')
      )
      .first();
    if (!conn || conn.status === 'disconnected') return null;
    const credentialSecret = await getCredentialValue(ctx, conn._id, 'webhook_secret');
    return credentialSecret ?? conn.webhookSecretRef ?? null;
  },
});

/**
 * Get Jinxxy webhook secret by routeId (authUserId).
 * Used by webhook handler for HMAC signature verification.
 */
export const getJinxxyWebhookSecretByRouteId = query({
  args: {
    apiSecret: v.string(),
    routeId: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_webhook_route_token', (q) => q.eq('webhookRouteToken', args.routeId))
      .filter((q) => q.eq(q.field('provider'), 'jinxxy'))
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
    authUserId: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.authUserId).eq('provider', 'gumroad')
      )
      .first();
    if (!conn) return null;
    const credentialSecret = await getCredentialValue(ctx, conn._id, 'webhook_secret');
    return credentialSecret ?? conn.webhookSecretRef ?? null;
  },
});

/**
 * Get Gumroad webhook secret by routeId (authUserId).
 * Used by webhook handler for signature verification.
 */
export const getGumroadWebhookSecretByRouteId = query({
  args: {
    apiSecret: v.string(),
    routeId: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.routeId).eq('provider', 'gumroad')
      )
      .first();
    if (!conn || conn.status === 'disconnected') return null;
    const credentialSecret = await getCredentialValue(ctx, conn._id, 'webhook_secret');
    return credentialSecret ?? conn.webhookSecretRef ?? null;
  },
});

/**
 * Generic: look up a credential by webhookRouteToken + provider + credentialKey.
 * Replaces per-provider queries (getJinxxyWebhookSecretByRouteId, getPayhipApiKeyByRouteId, etc.)
 * Webhook handlers should use this instead of provider-specific Convex queries.
 */
export const getWebhookCredentialByRouteId = query({
  args: {
    apiSecret: v.string(),
    routeId: v.string(),
    provider: v.string(),
    credentialKey: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_webhook_route_token', (q) => q.eq('webhookRouteToken', args.routeId))
      .filter((q) => q.eq(q.field('provider'), args.provider))
      .first();
    if (!conn || conn.status === 'disconnected') return null;
    const value = await getCredentialValue(ctx, conn._id, args.credentialKey);
    return value ?? conn.webhookSecretRef ?? null;
  },
});

/**
 * Generic: mark a connection's webhook as configured.
 * Replaces markPayhipWebhookConfigured, works for any provider.
 */
export const markWebhookConfigured = mutation({
  args: {
    apiSecret: v.string(),
    provider: v.string(),
    webhookRouteToken: v.optional(v.string()),
    authUserId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    let conn = null;

    if (args.webhookRouteToken) {
      conn = await ctx.db
        .query('provider_connections')
        .withIndex('by_webhook_route_token', (q) =>
          q.eq('webhookRouteToken', args.webhookRouteToken!)
        )
        .filter((q) => q.eq(q.field('provider'), args.provider))
        .first();
    } else if (args.authUserId) {
      conn = await ctx.db
        .query('provider_connections')
        .withIndex('by_auth_user_provider', (q) =>
          q.eq('authUserId', args.authUserId!).eq('provider', args.provider)
        )
        .first();
    }

    if (conn && !conn.webhookConfigured) {
      await ctx.db.patch(conn._id, { webhookConfigured: true, updatedAt: Date.now() });
    }
    return null;
  },
});

/**
 * Get connection status for a tenant. Returns a dynamic record keyed by
 * provider name so new providers are automatically included without code changes.
 */
export const getConnectionStatus = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.record(v.string(), v.boolean()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const [connections, collaboratorConnections] = await Promise.all([
      ctx.db
        .query('provider_connections')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
        .collect(),
      ctx.db
        .query('collaborator_connections')
        .withIndex('by_owner_status', (q) =>
          q.eq('ownerAuthUserId', args.authUserId).eq('status', 'active')
        )
        .collect(),
    ]);

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
        result[providerKey] = !!credValue;
      })
    );
    for (const connection of collaboratorConnections) {
      result[connection.provider] = true;
    }
    return result;
  },
});

/**
 * List all connections for a tenant with full status info.
 */
export const listConnections = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    const allowMismatchedEmails = profile?.policy?.allowMismatchedEmails ?? false;

    const connections = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
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
            status: c.status ?? (apiKey || apiToken || accessToken ? 'active' : 'disconnected'),
            authMode: c.authMode,
            externalShopId: c.externalShopId,
            externalShopName: c.externalShopName,
            webhookConfigured: c.webhookConfigured,
            hasApiKey: !!apiKey,
            hasApiToken: !!apiToken,
            hasAccessToken: !!accessToken,
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
    authUserId: v.string(),
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
    if (!connection || connection.authUserId !== args.authUserId) {
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
 * Get all credentials for a provider connection. Used by provider plugins' getCredential().
 * Returns a map of credentialKey -> encryptedValue.
 */
export const getConnectionForBackfill = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    provider: ProviderV,
  },
  returns: v.union(
    v.null(),
    v.object({
      credentials: v.record(v.string(), v.string()),
      webhookSecretRef: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.authUserId).eq('provider', args.provider)
      )
      .filter((q) => q.neq(q.field('status'), 'disconnected'))
      .first();
    if (!conn) return null;

    const credRows = await ctx.db
      .query('provider_credentials')
      .withIndex('by_connection', (q) => q.eq('providerConnectionId', conn._id))
      .collect();

    const credentials: Record<string, string> = {};
    for (const row of credRows) {
      if (row.encryptedValue) {
        credentials[row.credentialKey] = row.encryptedValue;
      }
    }

    // c91: webhookRouteToken is a routing secret that backfill callers do not need.
    // Returning it unnecessarily expands its blast radius.
    return {
      credentials,
      webhookSecretRef: conn.webhookSecretRef ?? undefined,
    };
  },
});

export const getConnectionByWebhookRouteToken = query({
  args: {
    apiSecret: v.string(),
    webhookRouteToken: v.string(),
  },
  returns: v.union(v.object({ authUserId: v.string() }), v.null()),
  handler: async (ctx, { apiSecret, webhookRouteToken }) => {
    requireApiSecret(apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_webhook_route_token', (q) => q.eq('webhookRouteToken', webhookRouteToken))
      .first();
    if (!conn) return null;
    return { authUserId: conn.authUserId };
  },
});

/**
 * Get or create the webhookRouteToken for a provider connection.
 * Returns null if no connection exists (caller must generate a pending token).
 */
export const getProviderConnectionWebhookRouteToken = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    providerKey: ProviderV,
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.authUserId).eq('provider', args.providerKey)
      )
      .first();
    if (!conn || conn.status === 'disconnected') return null;
    return conn.webhookRouteToken ?? null;
  },
});

export const createProviderConnection = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.optional(v.string()),
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
    if (!args.authUserId) {
      throw new Error('authUserId must be provided');
    }
    const now = Date.now();

    let existing = null;
    if (args.authUserId) {
      const authUserId = args.authUserId;
      existing = await ctx.db
        .query('provider_connections')
        .withIndex('by_auth_user_provider', (q) =>
          q.eq('authUserId', authUserId).eq('provider', args.providerKey)
        )
        .first();
    }

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
      authUserId: args.authUserId,
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
    authUserId: v.optional(v.string()),
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
    if (!args.authUserId) {
      throw new Error('authUserId must be provided');
    }
    const connection = await ctx.db.get(args.providerConnectionId);
    const ownedByUser = args.authUserId && connection?.authUserId === args.authUserId;
    if (!connection || !ownedByUser) {
      throw new Error('Connection not found or access denied');
    }

    const providerKey = getConnectionProviderKey(connection);
    const credentialId = await upsertCredential(ctx, {
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
    authUserId: v.optional(v.string()),
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
    if (!args.authUserId) {
      throw new Error('authUserId must be provided');
    }
    const connection = await ctx.db.get(args.providerConnectionId);
    const ownedByUser = args.authUserId && connection?.authUserId === args.authUserId;
    if (!connection || !ownedByUser) {
      throw new Error('Connection not found or access denied');
    }

    return await upsertCapability(ctx, {
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
 * Access is checked via authUserId.
 */
export const disconnectConnection = mutation({
  args: {
    apiSecret: v.string(),
    connectionId: v.id('provider_connections'),
    authUserId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db.get(args.connectionId);
    if (!conn) throw new Error('Connection not found');
    const ownedByUser = args.authUserId && conn.authUserId === args.authUserId;
    if (!ownedByUser) {
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
 * Return the provider key and encrypted credentials for a connection.
 * Used by the API disconnect handler to call the provider's onDisconnect hook
 * (e.g. unregistering external webhooks) before soft-deleting the connection.
 */
export const getConnectionForDisconnect = query({
  args: {
    apiSecret: v.string(),
    connectionId: v.id('provider_connections'),
    authUserId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      provider: v.string(),
      credentials: v.record(v.string(), v.string()),
      remoteWebhookId: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db.get(args.connectionId);
    if (!conn || conn.authUserId !== args.authUserId) return null;
    if (conn.status === 'disconnected') return null;

    const credRows = await ctx.db
      .query('provider_credentials')
      .withIndex('by_connection', (q) => q.eq('providerConnectionId', conn._id))
      .collect();

    const credentials: Record<string, string> = {};
    for (const row of credRows) {
      if (row.encryptedValue) {
        credentials[row.credentialKey] = row.encryptedValue;
      }
    }

    return {
      provider: conn.provider,
      credentials,
      remoteWebhookId: conn.remoteWebhookId,
    };
  },
});

/**
 * Update a specific tenant setting from the onboarding flow.
 */
export const updateTenantSetting = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    key: v.string(),
    value: v.any(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    // Per-key type validation
    type PolicyKeySpec = { type: 'boolean' | 'number' | 'string' | 'string[]'; enum?: string[] };
    const KNOWN_POLICY_KEYS: Record<string, PolicyKeySpec> = {
      maxBindingsPerProduct: { type: 'number' },
      allowTransfer: { type: 'boolean' },
      transferCooldownHours: { type: 'number' },
      allowSharedUse: { type: 'boolean' },
      maxUnityInstallations: { type: 'number' },
      autoVerifyOnJoin: { type: 'boolean' },
      revocationBehavior: { type: 'string', enum: ['immediate', 'grace_period', 'manual'] },
      gracePeriodHours: { type: 'number' },
      requireFullProductLinkSetOnSetup: { type: 'boolean' },
      allowCatalogLinkResolution: { type: 'boolean' },
      manualReviewRequired: { type: 'boolean' },
      discordRoleFreshnessMinutes: { type: 'number' },
      allowCatalogBackedVerification: { type: 'boolean' },
      autoDiscoverSupportedProductsForRememberedPurchaser: { type: 'boolean' },
      logChannelId: { type: 'string' },
      announcementsChannelId: { type: 'string' },
      verificationScope: { type: 'string', enum: ['account', 'license'] },
      shareVerificationWithServers: { type: 'boolean' },
      shareVerificationScope: { type: 'string' },
      duplicateVerificationBehavior: { type: 'string', enum: ['block', 'notify', 'allow'] },
      duplicateVerificationNotifyChannelId: { type: 'string' },
      suspiciousAccountBehavior: { type: 'string', enum: ['quarantine', 'notify', 'revoke'] },
      suspiciousNotifyChannelId: { type: 'string' },
      enableDiscordRoleFromOtherServers: { type: 'boolean' },
      allowedSourceGuildIds: { type: 'string[]' },
      allowMismatchedEmails: { type: 'boolean' },
    };

    const spec = KNOWN_POLICY_KEYS[args.key];
    if (!spec) {
      throw new Error(`Unknown policy key: ${args.key}`);
    }
    if (spec.type === 'boolean' && typeof args.value !== 'boolean') {
      throw new Error(`Policy key '${args.key}' must be a boolean`);
    } else if (spec.type === 'number' && typeof args.value !== 'number') {
      throw new Error(`Policy key '${args.key}' must be a number`);
    } else if (spec.type === 'string' && typeof args.value !== 'string') {
      throw new Error(`Policy key '${args.key}' must be a string`);
    } else if (spec.type === 'string[]') {
      if (!Array.isArray(args.value) || args.value.some((v: unknown) => typeof v !== 'string')) {
        throw new Error(`Policy key '${args.key}' must be an array of strings`);
      }
    }
    if (spec.enum && typeof args.value === 'string' && !spec.enum.includes(args.value)) {
      throw new Error(`Policy key '${args.key}' must be one of: ${spec.enum.join(', ')}`);
    }

    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    if (!profile) throw new Error('Creator profile not found');

    const policy = profile.policy ?? {};
    const updatedPolicy = { ...policy, [args.key]: args.value };

    await ctx.db.patch(profile._id, {
      policy: updatedPolicy,
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

/**
 * Generic: upsert a provider connection with credentials.
 * Each connect plugin calls this with its own credential keys.
 * No per-provider field names needed, all credentials go through provider_credentials table.
 */
export const upsertProviderConnection = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    providerKey: ProviderV,
    authMode: v.string(),
    label: v.optional(v.string()),
    externalShopId: v.optional(v.string()),
    externalShopName: v.optional(v.string()),
    webhookRouteToken: v.optional(v.string()),
    webhookConfigured: v.optional(v.boolean()),
    webhookEndpoint: v.optional(v.string()),
    webhookSecretRef: v.optional(v.string()),
    credentials: v.array(
      v.object({
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
        encryptedValue: v.string(),
      })
    ),
    capabilities: v.optional(
      v.array(
        v.object({
          capabilityKey: v.string(),
          status: v.union(
            v.literal('pending'),
            v.literal('available'),
            v.literal('configured'),
            v.literal('active'),
            v.literal('degraded'),
            v.literal('unsupported')
          ),
          requiredCredentialKeys: v.array(v.string()),
        })
      )
    ),
  },
  returns: v.id('provider_connections'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const existing = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.authUserId).eq('provider', args.providerKey)
      )
      .first();

    let connectionId: Id<'provider_connections'>;

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: 'active',
        authMode: args.authMode,
        ...(args.externalShopId !== undefined ? { externalShopId: args.externalShopId } : {}),
        ...(args.externalShopName !== undefined ? { externalShopName: args.externalShopName } : {}),
        ...(args.webhookRouteToken !== undefined
          ? { webhookRouteToken: args.webhookRouteToken }
          : {}),
        ...(args.webhookEndpoint !== undefined ? { webhookEndpoint: args.webhookEndpoint } : {}),
        ...(args.webhookSecretRef !== undefined ? { webhookSecretRef: args.webhookSecretRef } : {}),
        ...(args.webhookConfigured !== undefined
          ? { webhookConfigured: args.webhookConfigured }
          : {}),
        updatedAt: now,
      });
      connectionId = existing._id;
    } else {
      connectionId = await ctx.db.insert('provider_connections', {
        authUserId: args.authUserId,
        provider: args.providerKey,
        providerKey: args.providerKey,
        label: args.label ?? `${providerLabel(args.providerKey)} Connection`,
        connectionType: 'setup',
        status: 'active',
        authMode: args.authMode,
        externalShopId: args.externalShopId,
        externalShopName: args.externalShopName,
        webhookConfigured: args.webhookConfigured ?? false,
        webhookEndpoint: args.webhookEndpoint,
        webhookSecretRef: args.webhookSecretRef,
        webhookRouteToken: args.webhookRouteToken,
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const cred of args.credentials) {
      await upsertCredential(ctx, {
        providerConnectionId: connectionId,
        providerKey: args.providerKey,
        credentialKey: cred.credentialKey,
        kind: cred.kind,
        encryptedValue: cred.encryptedValue,
      });
    }

    if (args.capabilities) {
      for (const cap of args.capabilities) {
        await upsertCapability(ctx, {
          providerConnectionId: connectionId,
          providerKey: args.providerKey,
          capabilityKey: cap.capabilityKey,
          status: cap.status,
          requiredCredentialKeys: cap.requiredCredentialKeys,
        });
      }
    }

    return connectionId;
  },
});

/**
 * Upsert a VRChat creator connection.
 *
 * Stores the encrypted VRChat session (authToken + twoFactorAuthToken) in the
 * provider_credentials table under credentialKey='vrchat_session', kind='api_token'.
 * The plaintext value is NEVER stored; the caller must encrypt it first using
 * HKDF purpose 'vrchat-creator-session' before passing it here.
 */
export const upsertVrchatConnection = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    vrchatSessionEncrypted: v.string(),
  },
  returns: v.id('provider_connections'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const existing = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.authUserId).eq('provider', 'vrchat')
      )
      .first();

    let connectionId: Id<'provider_connections'>;

    if (existing) {
      await ctx.db.patch(existing._id, {
        providerKey: 'vrchat',
        status: 'active',
        authMode: 'session',
        updatedAt: now,
      });
      connectionId = existing._id;
    } else {
      connectionId = await ctx.db.insert('provider_connections', {
        authUserId: args.authUserId,
        provider: 'vrchat',
        providerKey: 'vrchat',
        label: 'VRChat Store',
        connectionType: 'setup',
        status: 'active',
        authMode: 'session',
        webhookConfigured: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    await upsertCredential(ctx, {
      providerConnectionId: connectionId,
      providerKey: 'vrchat',
      credentialKey: 'vrchat_session',
      kind: 'api_token',
      encryptedValue: args.vrchatSessionEncrypted,
    });

    await upsertCapability(ctx, {
      providerConnectionId: connectionId,
      providerKey: 'vrchat',
      capabilityKey: 'catalog_sync',
      status: 'configured',
      requiredCredentialKeys: ['vrchat_session'],
    });

    return connectionId;
  },
});

/**
 * Mark a provider connection as degraded, the credential exists but is no
 * longer functional (e.g. VRChat session expired, API key revoked).
 * The creator is notified to reconnect via the dashboard.
 */
export const markConnectionDegraded = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    provider: ProviderV,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.authUserId).eq('provider', args.provider)
      )
      .first();

    if (!conn) return null;
    await ctx.db.patch(conn._id, { status: 'degraded', updatedAt: Date.now() });
    return null;
  },
});

export const removeAccountForSubject = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const bindings = await ctx.db
      .query('bindings')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
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
    authUserId: v.string(),
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
      args.authUserId,
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
    authUserId: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.authUserId).eq('provider', 'payhip')
      )
      .first();
    if (!conn || conn.status === 'disconnected') return null;
    return getCredentialValue(ctx, conn._id, 'api_key');
  },
});

/**
 * Get the encrypted Payhip API key by routeId.
 * routeId is the Better Auth authUserId (user-scoped).
 * Used by the webhook handler for signature verification.
 */
export const getPayhipApiKeyByRouteId = query({
  args: {
    apiSecret: v.string(),
    routeId: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_webhook_route_token', (q) => q.eq('webhookRouteToken', args.routeId))
      .filter((q) => q.eq(q.field('provider'), 'payhip'))
      .first();
    if (!conn || conn.status === 'disconnected') return null;
    return getCredentialValue(ctx, conn._id, 'api_key');
  },
});

// ============================================================================
// USER-SCOPED QUERIES
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
  lastHealthcheckAt: v.optional(v.number()),
  lastSyncAt: v.optional(v.number()),
  lastWebhookAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

/**
 * List all active connections for a user.
 */
export const listConnectionsForUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.array(ConnectionSummaryV),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const allConnections = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.neq(q.field('status'), 'disconnected'))
      .collect();

    return allConnections.map((c) => ({
      id: c._id,
      provider: c.provider,
      label: c.label ?? `${c.provider} Connection`,
      connectionType: c.connectionType ?? 'setup',
      status: c.status ?? (c.webhookConfigured ? 'active' : 'disconnected'),
      webhookConfigured: c.webhookConfigured,
      hasApiKey: false,
      hasAccessToken: false,
      authUserId: c.authUserId,
      lastHealthcheckAt: c.lastHealthcheckAt,
      lastSyncAt: c.lastSyncAt,
      lastWebhookAt: c.lastWebhookAt,
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
    authUserId: v.string(),
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
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.authUserId).eq('provider', 'payhip')
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
    authUserId: v.optional(v.string()),
    encryptedApiKey: v.string(),
    label: v.optional(v.string()),
  },
  returns: v.object({
    connectionId: v.id('provider_connections'),
    webhookRouteToken: v.string(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    if (!args.authUserId) {
      throw new Error('authUserId must be provided');
    }
    const authUserId = args.authUserId;
    const now = Date.now();

    let conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', authUserId).eq('provider', 'payhip')
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
      // Generate an opaque route token so the webhook URL does not expose authUserId.
      const routeTokenBytes = new Uint8Array(32);
      crypto.getRandomValues(routeTokenBytes);
      const webhookRouteToken = Array.from(routeTokenBytes, (b) =>
        b.toString(16).padStart(2, '0')
      ).join('');
      const id = await ctx.db.insert('provider_connections', {
        authUserId: args.authUserId,
        provider: 'payhip' as any,
        providerKey: 'payhip' as any,
        label: connectionLabel,
        connectionType: 'setup',
        status: 'active',
        authMode: 'api_key',
        webhookConfigured: false,
        webhookRouteToken,
        createdAt: now,
        updatedAt: now,
      });
      conn = await ctx.db.get(id);
      if (!conn) throw new Error('Failed to create Payhip connection');
    }

    if (!conn.webhookRouteToken) {
      throw new Error('Payhip connection missing webhookRouteToken');
    }

    await upsertCredential(ctx, {
      providerConnectionId: conn._id,
      providerKey: 'payhip',
      credentialKey: 'api_key',
      kind: 'api_key',
      encryptedValue: args.encryptedApiKey,
    });

    await upsertCapability(ctx, {
      providerConnectionId: conn._id,
      providerKey: 'payhip',
      capabilityKey: 'webhooks',
      status: 'configured',
      requiredCredentialKeys: ['api_key'],
    });

    await upsertCapability(ctx, {
      providerConnectionId: conn._id,
      providerKey: 'payhip',
      capabilityKey: 'license_verification',
      status: 'pending',
      requiredCredentialKeys: [],
    });

    return { connectionId: conn._id, webhookRouteToken: conn.webhookRouteToken };
  },
});

/**
 * Credential key format: `{credentialKeyPrefix}{productId}` (e.g., `product_key:RGsF`).
 */
export const upsertProductCredential = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    /** Provider key (e.g., "payhip") */
    providerKey: ProviderV,
    /** Provider-specific product identifier (e.g., Payhip permalink "RGsF") */
    productId: v.string(),
    /** Prefix used to build the credential key (e.g., "product_key:") */
    credentialKeyPrefix: v.string(),
    /** Encrypted per-product secret value */
    encryptedSecretKey: v.string(),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.authUserId).eq('provider', args.providerKey)
      )
      .first();

    if (!conn) {
      throw new Error(
        `${providerLabel(args.providerKey)} connection not found. Connect ${providerLabel(args.providerKey)} first.`
      );
    }

    const credentialKey = `${args.credentialKeyPrefix}${args.productId}`;

    await upsertCredential(ctx, {
      providerConnectionId: conn._id,
      providerKey: args.providerKey,
      credentialKey,
      kind: 'api_key',
      encryptedValue: args.encryptedSecretKey,
      metadata: { productId: args.productId },
    });

    await upsertCapability(ctx, {
      providerConnectionId: conn._id,
      providerKey: args.providerKey,
      capabilityKey: 'license_verification',
      status: 'active',
      requiredCredentialKeys: [credentialKey],
    });

    return { success: true };
  },
});

/**
 * Get all Payhip products known for a tenant.
 *
 * Merges two sources:
 * 1. `provider_credentials` entries with key `product_key:{permalink}`, manually added at setup
 *    time, available before any webhooks fire.
 * 2. `provider_catalog_mappings` entries upserted from webhook events, carry human-readable
 *    product names discovered from real purchases.
 *
 * Returns a deduplicated list keyed by permalink. The `hasSecretKey` flag indicates whether
 * the creator has configured the per-product secret key required for license verification.
 */
export const getPayhipProducts = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
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
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.authUserId).eq('provider', 'payhip')
      )
      .first();

    if (!conn || conn.status === 'disconnected') return [];

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
/**
 * Stores the scraped product display name in `product_catalog` so it appears
 * in the product-role mapping list. Called fire-and-forget by the
 * `onProductCredentialAdded` hook after a Payhip product secret is added.
 *
 * Only updates displayName when the existing value is absent so webhook-sourced
 * names (which come from real transaction data) are never overwritten.
 */
export const upsertPayhipProductName = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    permalink: v.string(),
    displayName: v.string(),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const existing = await ctx.db
      .query('product_catalog')
      .withIndex('by_provider_ref', (q) =>
        q.eq('provider', 'payhip').eq('providerProductRef', args.permalink)
      )
      .filter((q) => q.eq(q.field('authUserId'), args.authUserId))
      .first();

    if (!existing) return { success: false };

    if (!existing.displayName) {
      await ctx.db.patch(existing._id, {
        displayName: args.displayName,
        updatedAt: Date.now(),
      });
    }

    return { success: true };
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

    const hasGumroad = gumroadUser
      ? !!(await getCredentialValue(ctx, gumroadUser._id, 'oauth_access_token'))
      : false;
    const hasJinxxy = jinxxyUser
      ? !!(await getCredentialValue(ctx, jinxxyUser._id, 'api_key'))
      : false;

    return { gumroad: hasGumroad, jinxxy: hasJinxxy };
  },
});

/**
 * Mark the Payhip webhook as configured (called after first successful webhook delivery).
 */
export const markPayhipWebhookConfigured = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.optional(v.string()),
    webhookRouteToken: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    let conn = null;

    if (args.webhookRouteToken) {
      conn = await ctx.db
        .query('provider_connections')
        .withIndex('by_webhook_route_token', (q) =>
          q.eq('webhookRouteToken', args.webhookRouteToken!)
        )
        .filter((q) => q.eq(q.field('provider'), 'payhip'))
        .first();
    } else if (args.authUserId) {
      const authUserId = args.authUserId;
      conn = await ctx.db
        .query('provider_connections')
        .withIndex('by_auth_user_provider', (q) =>
          q.eq('authUserId', authUserId).eq('provider', 'payhip')
        )
        .first();
    }

    if (conn && !conn.webhookConfigured) {
      await ctx.db.patch(conn._id, { webhookConfigured: true, updatedAt: Date.now() });
    }
    return null;
  },
});

// ============================================================================
// PUBLIC API QUERIES
// ============================================================================

export const listPublic = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    provider: v.optional(v.string()),
    status: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    let all = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    if (args.provider) {
      all = all.filter((c) => c.provider === args.provider || c.providerKey === args.provider);
    }
    if (args.status) {
      all = all.filter((c) => c.status === args.status);
    }

    const limit = Math.min(args.limit ?? 50, 100);
    let startIndex = 0;
    if (args.cursor) {
      const idx = all.findIndex((item) => String(item._id) === args.cursor);
      if (idx !== -1) startIndex = idx + 1;
    }
    const page = all.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < all.length;
    // Project: strip webhook secrets, route tokens, raw metadata, and internal fields
    const data = page.map((c) => ({
      id: c._id,
      provider: c.provider,
      providerKey: c.providerKey,
      label: c.label,
      connectionType: c.connectionType,
      status: c.status,
      authMode: c.authMode,
      externalShopId: c.externalShopId,
      externalShopName: c.externalShopName,
      webhookConfigured: c.webhookConfigured,
      lastHealthcheckAt: c.lastHealthcheckAt,
      lastSyncAt: c.lastSyncAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
    return {
      data,
      hasMore,
      nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    };
  },
});

export const getConnectionPublic = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    connectionId: v.id('provider_connections'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const c = await ctx.db.get(args.connectionId);
    if (!c || c.authUserId !== args.authUserId) return null;
    // Project: strip webhook secrets, route tokens, raw metadata, and internal fields
    return {
      id: c._id,
      provider: c.provider,
      providerKey: c.providerKey,
      label: c.label,
      connectionType: c.connectionType,
      status: c.status,
      authMode: c.authMode,
      externalShopId: c.externalShopId,
      externalShopName: c.externalShopName,
      webhookConfigured: c.webhookConfigured,
      lastHealthcheckAt: c.lastHealthcheckAt,
      lastSyncAt: c.lastSyncAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  },
});

export const listTransactionsByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    provider: v.optional(v.string()),
    status: v.optional(v.string()),
    subjectId: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    let all = await ctx.db
      .query('provider_transactions')
      .withIndex('by_auth_user_provider', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    if (args.provider) {
      all = all.filter((t) => t.providerKey === args.provider);
    }
    if (args.status) {
      all = all.filter((t) => t.status === args.status);
    }
    if (args.subjectId) {
      const allBindings = await ctx.db
        .query('bindings')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
        .collect();
      const subjectBindings = allBindings.filter((b) => String(b.subjectId) === args.subjectId);
      const emailHashes = new Set<string>();
      for (const binding of subjectBindings) {
        const extAccount = await ctx.db.get(binding.externalAccountId);
        if (extAccount?.emailHash) emailHashes.add(extAccount.emailHash);
      }
      all = all.filter((t) => t.customerEmailHash != null && emailHashes.has(t.customerEmailHash));
    }

    const limit = Math.min(args.limit ?? 50, 100);
    let startIndex = 0;
    if (args.cursor) {
      const idx = all.findIndex((item) => String(item._id) === args.cursor);
      if (idx !== -1) startIndex = idx + 1;
    }
    const page = all.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < all.length;
    // Project: strip customerEmail (PII plaintext), rawWebhookEventId, and metadata
    const data = page.map((t) => ({
      id: t._id,
      providerConnectionId: t.providerConnectionId,
      providerKey: t.providerKey,
      externalTransactionId: t.externalTransactionId,
      externalOrderNumber: t.externalOrderNumber,
      externalOrderItemId: t.externalOrderItemId,
      externalStoreId: t.externalStoreId,
      externalProductId: t.externalProductId,
      externalVariantId: t.externalVariantId,
      externalCustomerId: t.externalCustomerId,
      currency: t.currency,
      amountSubtotal: t.amountSubtotal,
      amountTotal: t.amountTotal,
      status: t.status,
      purchasedAt: t.purchasedAt,
      refundedAt: t.refundedAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
    return {
      data,
      hasMore,
      nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    };
  },
});

export const getTransactionById = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    transactionId: v.id('provider_transactions'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const t = await ctx.db.get(args.transactionId);
    if (!t || t.authUserId !== args.authUserId) return null;
    // Project: strip customerEmail (PII plaintext), rawWebhookEventId, and metadata
    return {
      id: t._id,
      providerConnectionId: t.providerConnectionId,
      providerKey: t.providerKey,
      externalTransactionId: t.externalTransactionId,
      externalOrderNumber: t.externalOrderNumber,
      externalOrderItemId: t.externalOrderItemId,
      externalStoreId: t.externalStoreId,
      externalProductId: t.externalProductId,
      externalVariantId: t.externalVariantId,
      externalCustomerId: t.externalCustomerId,
      currency: t.currency,
      amountSubtotal: t.amountSubtotal,
      amountTotal: t.amountTotal,
      status: t.status,
      purchasedAt: t.purchasedAt,
      refundedAt: t.refundedAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  },
});

export const listMembershipsByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    provider: v.optional(v.string()),
    status: v.optional(v.string()),
    subjectId: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    let all = await ctx.db
      .query('provider_memberships')
      .withIndex('by_auth_user_provider', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    if (args.provider) {
      all = all.filter((m) => m.providerKey === args.provider);
    }
    if (args.status) {
      all = all.filter((m) => m.status === args.status);
    }
    if (args.subjectId) {
      const allBindings = await ctx.db
        .query('bindings')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
        .collect();
      const subjectBindings = allBindings.filter((b) => String(b.subjectId) === args.subjectId);
      const emailHashes = new Set<string>();
      for (const binding of subjectBindings) {
        const extAccount = await ctx.db.get(binding.externalAccountId);
        if (extAccount?.emailHash) emailHashes.add(extAccount.emailHash);
      }
      all = all.filter((m) => m.customerEmailHash != null && emailHashes.has(m.customerEmailHash));
    }

    const limit = Math.min(args.limit ?? 50, 100);
    let startIndex = 0;
    if (args.cursor) {
      const idx = all.findIndex((item) => String(item._id) === args.cursor);
      if (idx !== -1) startIndex = idx + 1;
    }
    const page = all.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < all.length;
    // Project: strip customerEmail (PII plaintext), rawWebhookEventId, and metadata
    const data = page.map((m) => ({
      id: m._id,
      providerConnectionId: m.providerConnectionId,
      providerKey: m.providerKey,
      externalMembershipId: m.externalMembershipId,
      externalTransactionId: m.externalTransactionId,
      externalProductId: m.externalProductId,
      externalVariantId: m.externalVariantId,
      externalCustomerId: m.externalCustomerId,
      status: m.status,
      startedAt: m.startedAt,
      renewsAt: m.renewsAt,
      endsAt: m.endsAt,
      cancelledAt: m.cancelledAt,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
    return {
      data,
      hasMore,
      nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    };
  },
});

export const getMembershipById = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    membershipId: v.id('provider_memberships'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const m = await ctx.db.get(args.membershipId);
    if (!m || m.authUserId !== args.authUserId) return null;
    // Project: strip customerEmail (PII plaintext), rawWebhookEventId, and metadata
    return {
      id: m._id,
      providerConnectionId: m.providerConnectionId,
      providerKey: m.providerKey,
      externalMembershipId: m.externalMembershipId,
      externalTransactionId: m.externalTransactionId,
      externalProductId: m.externalProductId,
      externalVariantId: m.externalVariantId,
      externalCustomerId: m.externalCustomerId,
      status: m.status,
      startedAt: m.startedAt,
      renewsAt: m.renewsAt,
      endsAt: m.endsAt,
      cancelledAt: m.cancelledAt,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  },
});

export const listProviderLicensesByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    provider: v.optional(v.string()),
    status: v.optional(v.string()),
    subjectId: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    let all = await ctx.db
      .query('provider_licenses')
      .withIndex('by_auth_user_provider', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    if (args.provider) {
      all = all.filter((l) => l.providerKey === args.provider);
    }
    if (args.status) {
      all = all.filter((l) => l.status === args.status);
    }
    if (args.subjectId) {
      const allBindings = await ctx.db
        .query('bindings')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
        .collect();
      const subjectBindings = allBindings.filter((b) => String(b.subjectId) === args.subjectId);
      const emailHashes = new Set<string>();
      for (const binding of subjectBindings) {
        const extAccount = await ctx.db.get(binding.externalAccountId);
        if (extAccount?.emailHash) emailHashes.add(extAccount.emailHash);
      }
      all = all.filter((l) => l.customerEmailHash != null && emailHashes.has(l.customerEmailHash));
    }

    const limit = Math.min(args.limit ?? 50, 100);
    let startIndex = 0;
    if (args.cursor) {
      const idx = all.findIndex((item) => String(item._id) === args.cursor);
      if (idx !== -1) startIndex = idx + 1;
    }
    const page = all.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < all.length;
    // Project: strip customerEmail (PII plaintext), licenseKeyHash, rawWebhookEventId, and metadata
    const data = page.map((l) => ({
      id: l._id,
      providerConnectionId: l.providerConnectionId,
      providerKey: l.providerKey,
      externalLicenseId: l.externalLicenseId,
      externalTransactionId: l.externalTransactionId,
      externalProductId: l.externalProductId,
      externalVariantId: l.externalVariantId,
      externalCustomerId: l.externalCustomerId,
      shortKey: l.shortKey,
      status: l.status,
      issuedAt: l.issuedAt,
      expiresAt: l.expiresAt,
      lastValidatedAt: l.lastValidatedAt,
      revokedAt: l.revokedAt,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    }));
    return {
      data,
      hasMore,
      nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    };
  },
});

export const getProviderLicenseById = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    licenseId: v.id('provider_licenses'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const l = await ctx.db.get(args.licenseId);
    if (!l || l.authUserId !== args.authUserId) return null;
    // Project: strip customerEmail (PII plaintext), licenseKeyHash, rawWebhookEventId, and metadata
    return {
      id: l._id,
      providerConnectionId: l.providerConnectionId,
      providerKey: l.providerKey,
      externalLicenseId: l.externalLicenseId,
      externalTransactionId: l.externalTransactionId,
      externalProductId: l.externalProductId,
      externalVariantId: l.externalVariantId,
      externalCustomerId: l.externalCustomerId,
      shortKey: l.shortKey,
      status: l.status,
      issuedAt: l.issuedAt,
      expiresAt: l.expiresAt,
      lastValidatedAt: l.lastValidatedAt,
      revokedAt: l.revokedAt,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    };
  },
});
