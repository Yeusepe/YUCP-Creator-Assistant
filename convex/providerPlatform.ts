import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { ProviderV } from './lib/providers';

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

export const upsertCatalogMapping = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    providerConnectionId: v.id('provider_connections'),
    providerKey: ProviderV,
    catalogProductId: v.optional(v.id('product_catalog')),
    localProductId: v.optional(v.string()),
    externalStoreId: v.optional(v.string()),
    externalProductId: v.optional(v.string()),
    externalVariantId: v.optional(v.string()),
    externalPriceId: v.optional(v.string()),
    externalSku: v.optional(v.string()),
    displayName: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  returns: v.id('provider_catalog_mappings'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const existing = args.externalVariantId
      ? await ctx.db
          .query('provider_catalog_mappings')
          .withIndex('by_external_variant', (q) =>
            q.eq('providerKey', args.providerKey).eq('externalVariantId', args.externalVariantId)
          )
          .first()
      : null;

    if (existing) {
      await ctx.db.patch(existing._id, {
        catalogProductId: args.catalogProductId ?? existing.catalogProductId,
        localProductId: args.localProductId ?? existing.localProductId,
        externalStoreId: args.externalStoreId ?? existing.externalStoreId,
        externalProductId: args.externalProductId ?? existing.externalProductId,
        externalPriceId: args.externalPriceId ?? existing.externalPriceId,
        externalSku: args.externalSku ?? existing.externalSku,
        displayName: args.displayName ?? existing.displayName,
        metadata: args.metadata ?? existing.metadata,
        status: 'active',
        lastSyncedAt: now,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert('provider_catalog_mappings', {
      tenantId: args.tenantId,
      providerConnectionId: args.providerConnectionId,
      providerKey: args.providerKey,
      catalogProductId: args.catalogProductId,
      localProductId: args.localProductId,
      externalStoreId: args.externalStoreId,
      externalProductId: args.externalProductId,
      externalVariantId: args.externalVariantId,
      externalPriceId: args.externalPriceId,
      externalSku: args.externalSku,
      displayName: args.displayName,
      status: 'active',
      metadata: args.metadata,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const upsertProviderTransaction = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    providerConnectionId: v.id('provider_connections'),
    providerKey: ProviderV,
    externalTransactionId: v.string(),
    externalOrderNumber: v.optional(v.string()),
    externalOrderItemId: v.optional(v.string()),
    externalStoreId: v.optional(v.string()),
    externalProductId: v.optional(v.string()),
    externalVariantId: v.optional(v.string()),
    externalCustomerId: v.optional(v.string()),
    customerEmail: v.optional(v.string()),
    customerEmailHash: v.optional(v.string()),
    currency: v.optional(v.string()),
    amountSubtotal: v.optional(v.number()),
    amountTotal: v.optional(v.number()),
    status: v.union(
      v.literal('pending'),
      v.literal('paid'),
      v.literal('refunded'),
      v.literal('partial_refund'),
      v.literal('disputed'),
      v.literal('failed'),
      v.literal('cancelled')
    ),
    purchasedAt: v.optional(v.number()),
    refundedAt: v.optional(v.number()),
    rawWebhookEventId: v.optional(v.id('webhook_events')),
    metadata: v.optional(v.any()),
  },
  returns: v.id('provider_transactions'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const existing = await ctx.db
      .query('provider_transactions')
      .withIndex('by_external_id', (q) =>
        q.eq('providerKey', args.providerKey).eq('externalTransactionId', args.externalTransactionId)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        externalOrderNumber: args.externalOrderNumber ?? existing.externalOrderNumber,
        externalOrderItemId: args.externalOrderItemId ?? existing.externalOrderItemId,
        externalStoreId: args.externalStoreId ?? existing.externalStoreId,
        externalProductId: args.externalProductId ?? existing.externalProductId,
        externalVariantId: args.externalVariantId ?? existing.externalVariantId,
        externalCustomerId: args.externalCustomerId ?? existing.externalCustomerId,
        customerEmail: args.customerEmail ?? existing.customerEmail,
        customerEmailHash: args.customerEmailHash ?? existing.customerEmailHash,
        currency: args.currency ?? existing.currency,
        amountSubtotal: args.amountSubtotal ?? existing.amountSubtotal,
        amountTotal: args.amountTotal ?? existing.amountTotal,
        status: args.status,
        purchasedAt: args.purchasedAt ?? existing.purchasedAt,
        refundedAt: args.refundedAt ?? existing.refundedAt,
        rawWebhookEventId: args.rawWebhookEventId ?? existing.rawWebhookEventId,
        metadata: args.metadata ?? existing.metadata,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert('provider_transactions', {
      tenantId: args.tenantId,
      providerConnectionId: args.providerConnectionId,
      providerKey: args.providerKey,
      externalTransactionId: args.externalTransactionId,
      externalOrderNumber: args.externalOrderNumber,
      externalOrderItemId: args.externalOrderItemId,
      externalStoreId: args.externalStoreId,
      externalProductId: args.externalProductId,
      externalVariantId: args.externalVariantId,
      externalCustomerId: args.externalCustomerId,
      customerEmail: args.customerEmail,
      customerEmailHash: args.customerEmailHash,
      currency: args.currency,
      amountSubtotal: args.amountSubtotal,
      amountTotal: args.amountTotal,
      status: args.status,
      purchasedAt: args.purchasedAt,
      refundedAt: args.refundedAt,
      rawWebhookEventId: args.rawWebhookEventId,
      metadata: args.metadata,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const upsertProviderMembership = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    providerConnectionId: v.id('provider_connections'),
    providerKey: ProviderV,
    externalMembershipId: v.string(),
    externalTransactionId: v.optional(v.string()),
    externalProductId: v.optional(v.string()),
    externalVariantId: v.optional(v.string()),
    externalCustomerId: v.optional(v.string()),
    customerEmail: v.optional(v.string()),
    customerEmailHash: v.optional(v.string()),
    status: v.union(
      v.literal('trialing'),
      v.literal('active'),
      v.literal('paused'),
      v.literal('past_due'),
      v.literal('cancelled'),
      v.literal('expired')
    ),
    startedAt: v.optional(v.number()),
    renewsAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    rawWebhookEventId: v.optional(v.id('webhook_events')),
    metadata: v.optional(v.any()),
  },
  returns: v.id('provider_memberships'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const existing = await ctx.db
      .query('provider_memberships')
      .withIndex('by_external_id', (q) =>
        q.eq('providerKey', args.providerKey).eq('externalMembershipId', args.externalMembershipId)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        externalTransactionId: args.externalTransactionId ?? existing.externalTransactionId,
        externalProductId: args.externalProductId ?? existing.externalProductId,
        externalVariantId: args.externalVariantId ?? existing.externalVariantId,
        externalCustomerId: args.externalCustomerId ?? existing.externalCustomerId,
        customerEmail: args.customerEmail ?? existing.customerEmail,
        customerEmailHash: args.customerEmailHash ?? existing.customerEmailHash,
        status: args.status,
        startedAt: args.startedAt ?? existing.startedAt,
        renewsAt: args.renewsAt ?? existing.renewsAt,
        endsAt: args.endsAt ?? existing.endsAt,
        cancelledAt: args.cancelledAt ?? existing.cancelledAt,
        rawWebhookEventId: args.rawWebhookEventId ?? existing.rawWebhookEventId,
        metadata: args.metadata ?? existing.metadata,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert('provider_memberships', {
      tenantId: args.tenantId,
      providerConnectionId: args.providerConnectionId,
      providerKey: args.providerKey,
      externalMembershipId: args.externalMembershipId,
      externalTransactionId: args.externalTransactionId,
      externalProductId: args.externalProductId,
      externalVariantId: args.externalVariantId,
      externalCustomerId: args.externalCustomerId,
      customerEmail: args.customerEmail,
      customerEmailHash: args.customerEmailHash,
      status: args.status,
      startedAt: args.startedAt,
      renewsAt: args.renewsAt,
      endsAt: args.endsAt,
      cancelledAt: args.cancelledAt,
      rawWebhookEventId: args.rawWebhookEventId,
      metadata: args.metadata,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const upsertProviderLicense = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    providerConnectionId: v.id('provider_connections'),
    providerKey: ProviderV,
    externalLicenseId: v.string(),
    externalTransactionId: v.optional(v.string()),
    externalProductId: v.optional(v.string()),
    externalVariantId: v.optional(v.string()),
    externalCustomerId: v.optional(v.string()),
    customerEmail: v.optional(v.string()),
    customerEmailHash: v.optional(v.string()),
    licenseKeyHash: v.optional(v.string()),
    shortKey: v.optional(v.string()),
    status: v.union(
      v.literal('active'),
      v.literal('inactive'),
      v.literal('expired'),
      v.literal('revoked'),
      v.literal('disabled')
    ),
    issuedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    lastValidatedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    rawWebhookEventId: v.optional(v.id('webhook_events')),
    metadata: v.optional(v.any()),
  },
  returns: v.id('provider_licenses'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const existing = await ctx.db
      .query('provider_licenses')
      .withIndex('by_external_id', (q) =>
        q.eq('providerKey', args.providerKey).eq('externalLicenseId', args.externalLicenseId)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        externalTransactionId: args.externalTransactionId ?? existing.externalTransactionId,
        externalProductId: args.externalProductId ?? existing.externalProductId,
        externalVariantId: args.externalVariantId ?? existing.externalVariantId,
        externalCustomerId: args.externalCustomerId ?? existing.externalCustomerId,
        customerEmail: args.customerEmail ?? existing.customerEmail,
        customerEmailHash: args.customerEmailHash ?? existing.customerEmailHash,
        licenseKeyHash: args.licenseKeyHash ?? existing.licenseKeyHash,
        shortKey: args.shortKey ?? existing.shortKey,
        status: args.status,
        issuedAt: args.issuedAt ?? existing.issuedAt,
        expiresAt: args.expiresAt ?? existing.expiresAt,
        lastValidatedAt: args.lastValidatedAt ?? existing.lastValidatedAt,
        revokedAt: args.revokedAt ?? existing.revokedAt,
        rawWebhookEventId: args.rawWebhookEventId ?? existing.rawWebhookEventId,
        metadata: args.metadata ?? existing.metadata,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert('provider_licenses', {
      tenantId: args.tenantId,
      providerConnectionId: args.providerConnectionId,
      providerKey: args.providerKey,
      externalLicenseId: args.externalLicenseId,
      externalTransactionId: args.externalTransactionId,
      externalProductId: args.externalProductId,
      externalVariantId: args.externalVariantId,
      externalCustomerId: args.externalCustomerId,
      customerEmail: args.customerEmail,
      customerEmailHash: args.customerEmailHash,
      licenseKeyHash: args.licenseKeyHash,
      shortKey: args.shortKey,
      status: args.status,
      issuedAt: args.issuedAt,
      expiresAt: args.expiresAt,
      lastValidatedAt: args.lastValidatedAt,
      revokedAt: args.revokedAt,
      rawWebhookEventId: args.rawWebhookEventId,
      metadata: args.metadata,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const upsertEntitlementEvidence = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    subjectId: v.optional(v.id('subjects')),
    providerKey: ProviderV,
    providerConnectionId: v.optional(v.id('provider_connections')),
    transactionId: v.optional(v.id('provider_transactions')),
    membershipId: v.optional(v.id('provider_memberships')),
    licenseId: v.optional(v.id('provider_licenses')),
    sourceReference: v.string(),
    evidenceType: v.string(),
    status: v.union(
      v.literal('pending'),
      v.literal('active'),
      v.literal('revoked'),
      v.literal('superseded')
    ),
    productId: v.optional(v.string()),
    catalogProductId: v.optional(v.id('product_catalog')),
    rawWebhookEventId: v.optional(v.id('webhook_events')),
    metadata: v.optional(v.any()),
    observedAt: v.number(),
  },
  returns: v.id('entitlement_evidence'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const existing = await ctx.db
      .query('entitlement_evidence')
      .withIndex('by_source_reference', (q) =>
        q.eq('providerKey', args.providerKey).eq('sourceReference', args.sourceReference)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        subjectId: args.subjectId ?? existing.subjectId,
        providerConnectionId: args.providerConnectionId ?? existing.providerConnectionId,
        transactionId: args.transactionId ?? existing.transactionId,
        membershipId: args.membershipId ?? existing.membershipId,
        licenseId: args.licenseId ?? existing.licenseId,
        status: args.status,
        productId: args.productId ?? existing.productId,
        catalogProductId: args.catalogProductId ?? existing.catalogProductId,
        rawWebhookEventId: args.rawWebhookEventId ?? existing.rawWebhookEventId,
        metadata: args.metadata ?? existing.metadata,
        observedAt: args.observedAt,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert('entitlement_evidence', {
      tenantId: args.tenantId,
      subjectId: args.subjectId,
      providerKey: args.providerKey,
      providerConnectionId: args.providerConnectionId,
      transactionId: args.transactionId,
      membershipId: args.membershipId,
      licenseId: args.licenseId,
      sourceReference: args.sourceReference,
      evidenceType: args.evidenceType,
      status: args.status,
      productId: args.productId,
      catalogProductId: args.catalogProductId,
      rawWebhookEventId: args.rawWebhookEventId,
      metadata: args.metadata,
      observedAt: args.observedAt,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const listCatalogMappingsForConnection = query({
  args: {
    apiSecret: v.string(),
    providerConnectionId: v.id('provider_connections'),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await ctx.db
      .query('provider_catalog_mappings')
      .withIndex('by_connection', (q) => q.eq('providerConnectionId', args.providerConnectionId))
      .collect();
  },
});

export const getProviderConnectionAdmin = query({
  args: {
    apiSecret: v.string(),
    providerConnectionId: v.id('provider_connections'),
  },
  returns: v.union(
    v.null(),
    v.object({
      connectionId: v.id('provider_connections'),
      tenantId: v.id('tenants'),
      providerKey: ProviderV,
      provider: v.string(),
      label: v.optional(v.string()),
      status: v.optional(v.string()),
      authMode: v.optional(v.string()),
      externalShopId: v.optional(v.string()),
      externalShopName: v.optional(v.string()),
      webhookConfigured: v.boolean(),
      webhookEndpoint: v.optional(v.string()),
      remoteWebhookId: v.optional(v.string()),
      remoteWebhookSecretRef: v.optional(v.string()),
      testMode: v.optional(v.boolean()),
      metadata: v.optional(v.any()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const connection = await ctx.db.get(args.providerConnectionId);
    if (!connection) {
      return null;
    }

    return {
      connectionId: connection._id,
      tenantId: connection.tenantId,
      providerKey: (connection.providerKey ?? connection.provider) as any,
      provider: connection.provider,
      label: connection.label,
      status: connection.status,
      authMode: connection.authMode,
      externalShopId: connection.externalShopId,
      externalShopName: connection.externalShopName,
      webhookConfigured: connection.webhookConfigured,
      webhookEndpoint: connection.webhookEndpoint,
      remoteWebhookId: connection.remoteWebhookId,
      remoteWebhookSecretRef: connection.remoteWebhookSecretRef,
      testMode: connection.testMode,
      metadata: connection.metadata,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
  },
});

export const updateProviderConnectionState = mutation({
  args: {
    apiSecret: v.string(),
    providerConnectionId: v.id('provider_connections'),
    status: v.optional(
      v.union(
        v.literal('pending'),
        v.literal('active'),
        v.literal('degraded'),
        v.literal('disconnected'),
        v.literal('error')
      )
    ),
    authMode: v.optional(v.string()),
    label: v.optional(v.string()),
    externalShopId: v.optional(v.string()),
    externalShopName: v.optional(v.string()),
    webhookConfigured: v.optional(v.boolean()),
    webhookEndpoint: v.optional(v.string()),
    remoteWebhookId: v.optional(v.string()),
    remoteWebhookSecretRef: v.optional(v.string()),
    lastHealthcheckAt: v.optional(v.number()),
    lastSyncAt: v.optional(v.number()),
    lastWebhookAt: v.optional(v.number()),
    testMode: v.optional(v.boolean()),
    metadata: v.optional(v.any()),
  },
  returns: v.id('provider_connections'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const connection = await ctx.db.get(args.providerConnectionId);
    if (!connection) {
      throw new Error('Provider connection not found');
    }

    await ctx.db.patch(args.providerConnectionId, {
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.authMode !== undefined ? { authMode: args.authMode } : {}),
      ...(args.label !== undefined ? { label: args.label } : {}),
      ...(args.externalShopId !== undefined ? { externalShopId: args.externalShopId } : {}),
      ...(args.externalShopName !== undefined
        ? { externalShopName: args.externalShopName }
        : {}),
      ...(args.webhookConfigured !== undefined
        ? { webhookConfigured: args.webhookConfigured }
        : {}),
      ...(args.webhookEndpoint !== undefined ? { webhookEndpoint: args.webhookEndpoint } : {}),
      ...(args.remoteWebhookId !== undefined ? { remoteWebhookId: args.remoteWebhookId } : {}),
      ...(args.remoteWebhookSecretRef !== undefined
        ? { remoteWebhookSecretRef: args.remoteWebhookSecretRef }
        : {}),
      ...(args.lastHealthcheckAt !== undefined
        ? { lastHealthcheckAt: args.lastHealthcheckAt }
        : {}),
      ...(args.lastSyncAt !== undefined ? { lastSyncAt: args.lastSyncAt } : {}),
      ...(args.lastWebhookAt !== undefined ? { lastWebhookAt: args.lastWebhookAt } : {}),
      ...(args.testMode !== undefined ? { testMode: args.testMode } : {}),
      ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
      updatedAt: Date.now(),
    });

    return args.providerConnectionId;
  },
});

export const listCatalogProductsForTenant = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
  },
  returns: v.array(
    v.object({
      _id: v.id('product_catalog'),
      productId: v.string(),
      provider: ProviderV,
      providerProductRef: v.string(),
      canonicalSlug: v.optional(v.string()),
      displayName: v.optional(v.string()),
      status: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const products = await ctx.db
      .query('product_catalog')
      .withIndex('by_tenant', (q) => q.eq('tenantId', args.tenantId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    return products.map((product) => ({
      _id: product._id,
      productId: product.productId,
      provider: product.provider,
      providerProductRef: product.providerProductRef,
      canonicalSlug: product.canonicalSlug,
      displayName: product.displayName,
      status: product.status,
    }));
  },
});

async function findSubjectByEmailHash(
  ctx: any,
  tenantId: Id<'tenants'>,
  emailHash: string
): Promise<Id<'subjects'> | null> {
  const externalAccounts = await ctx.db
    .query('external_accounts')
    .withIndex('by_email_hash', (q: any) => q.eq('emailHash', emailHash))
    .filter((q: any) => q.eq(q.field('status'), 'active'))
    .collect();

  for (const account of externalAccounts) {
    const binding = await ctx.db
      .query('bindings')
      .withIndex('by_tenant_external', (q: any) =>
        q.eq('tenantId', tenantId).eq('externalAccountId', account._id)
      )
      .filter((q: any) => q.eq(q.field('status'), 'active'))
      .first();
    if (binding) {
      return binding.subjectId;
    }
  }

  return null;
}

export const resolveTenantSubjectByEmailHash = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    emailHash: v.string(),
  },
  returns: v.union(v.null(), v.id('subjects')),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await findSubjectByEmailHash(ctx, args.tenantId, args.emailHash);
  },
});
