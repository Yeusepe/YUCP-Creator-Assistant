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
    tenantId: Id<'tenants'>;
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
    tenantId: Id<'tenants'>;
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

    if (!conn) return null;

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
 */
export const disconnectConnection = mutation({
  args: {
    apiSecret: v.string(),
    connectionId: v.id('provider_connections'),
    tenantId: v.id('tenants'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db.get(args.connectionId);
    if (!conn || conn.tenantId !== args.tenantId) {
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
 */
export const upsertGumroadConnection = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    gumroadAccessTokenEncrypted: v.string(),
    gumroadRefreshTokenEncrypted: v.optional(v.string()),
    gumroadUserId: v.optional(v.string()),
  },
  returns: v.id('provider_connections'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const existing = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', 'gumroad')
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        providerKey: 'gumroad',
        status: 'active',
        authMode: 'oauth',
        gumroadAccessTokenEncrypted: args.gumroadAccessTokenEncrypted,
        gumroadRefreshTokenEncrypted:
          args.gumroadRefreshTokenEncrypted ?? existing.gumroadRefreshTokenEncrypted,
        gumroadUserId: args.gumroadUserId ?? existing.gumroadUserId,
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
 * Called from Discord setup when creator configures Jinxxy.
 */
export const upsertJinxxyConnection = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    jinxxyApiKeyEncrypted: v.optional(v.string()),
    webhookSecretRef: v.optional(v.string()),
    webhookEndpoint: v.optional(v.string()),
  },
  returns: v.id('provider_connections'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const existing = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', 'jinxxy')
      )
      .first();

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
