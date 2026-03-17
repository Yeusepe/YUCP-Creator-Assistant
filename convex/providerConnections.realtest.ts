/**
 * Integration tests for provider connection credential storage and reset helpers.
 *
 * Run with: npx vitest run --config convex/vitest.config.ts convex/providerConnections.realtest.ts
 *
 * Security refs:
 * - https://docs.convex.dev/testing/convex-test
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import { makeTestConvex } from './testHelpers';

const API_SECRET = 'test-secret';

async function getProviderSnapshot(t: ReturnType<typeof makeTestConvex>, authUserId: string) {
  return t.run(async (ctx) => {
    const connections = (await ctx.db.query('provider_connections').collect()).filter(
      (doc) => doc.authUserId === authUserId
    );
    const connectionIds = new Set(connections.map((doc) => doc._id));

    const credentials = (await ctx.db.query('provider_credentials').collect()).filter((doc) =>
      connectionIds.has(doc.providerConnectionId)
    );
    const capabilities = (await ctx.db.query('provider_connection_capabilities').collect()).filter(
      (doc) => connectionIds.has(doc.providerConnectionId)
    );
    const catalogMappings = (await ctx.db.query('provider_catalog_mappings').collect()).filter(
      (doc) => doc.authUserId === authUserId
    );
    const transactions = (await ctx.db.query('provider_transactions').collect()).filter(
      (doc) => doc.authUserId === authUserId
    );
    const memberships = (await ctx.db.query('provider_memberships').collect()).filter(
      (doc) => doc.authUserId === authUserId
    );
    const licenses = (await ctx.db.query('provider_licenses').collect()).filter(
      (doc) => doc.authUserId === authUserId
    );

    const transactionIds = new Set(transactions.map((doc) => doc._id));
    const membershipIds = new Set(memberships.map((doc) => doc._id));
    const licenseIds = new Set(licenses.map((doc) => doc._id));

    const entitlementEvidence = (await ctx.db.query('entitlement_evidence').collect()).filter(
      (doc) =>
        doc.authUserId === authUserId ||
        (doc.providerConnectionId != null && connectionIds.has(doc.providerConnectionId)) ||
        (doc.transactionId != null && transactionIds.has(doc.transactionId)) ||
        (doc.membershipId != null && membershipIds.has(doc.membershipId)) ||
        (doc.licenseId != null && licenseIds.has(doc.licenseId))
    );
    const webhookEvents = (await ctx.db.query('webhook_events').collect()).filter(
      (doc) =>
        doc.authUserId === authUserId &&
        (doc.providerConnectionId == null || connectionIds.has(doc.providerConnectionId))
    );

    return {
      connections,
      credentials,
      capabilities,
      catalogMappings,
      transactions,
      memberships,
      licenses,
      entitlementEvidence,
      webhookEvents,
    };
  });
}

function countSnapshot(snapshot: Awaited<ReturnType<typeof getProviderSnapshot>>) {
  return {
    providerConnections: snapshot.connections.length,
    providerCredentials: snapshot.credentials.length,
    providerConnectionCapabilities: snapshot.capabilities.length,
    providerCatalogMappings: snapshot.catalogMappings.length,
    providerTransactions: snapshot.transactions.length,
    providerMemberships: snapshot.memberships.length,
    providerLicenses: snapshot.licenses.length,
    entitlementEvidence: snapshot.entitlementEvidence.length,
    webhookEvents: snapshot.webhookEvents.length,
  };
}

async function seedProviderResetFixture(t: ReturnType<typeof makeTestConvex>, authUserId: string) {
  const connectionId = await t.mutation(api.providerConnections.upsertProviderConnection, {
    apiSecret: API_SECRET,
    authUserId,
    providerKey: 'jinxxy',
    authMode: 'api_key',
    credentials: [
      {
        credentialKey: 'api_key',
        kind: 'api_key',
        encryptedValue: `enc-${authUserId}`,
      },
    ],
    capabilities: [
      {
        capabilityKey: 'catalog_sync',
        status: 'active',
        requiredCredentialKeys: ['api_key'],
      },
    ],
  });

  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert('provider_catalog_mappings', {
      authUserId,
      providerConnectionId: connectionId,
      providerKey: 'jinxxy',
      externalProductId: `product-${authUserId}`,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    const webhookEventId = await ctx.db.insert('webhook_events', {
      provider: 'jinxxy',
      providerKey: 'jinxxy',
      providerConnectionId: connectionId,
      providerEventId: `evt-${authUserId}`,
      eventType: 'sale',
      rawPayload: {},
      signatureValid: true,
      status: 'processed',
      authUserId,
      receivedAt: now,
      processedAt: now,
    });

    const transactionId = await ctx.db.insert('provider_transactions', {
      authUserId,
      providerConnectionId: connectionId,
      providerKey: 'jinxxy',
      externalTransactionId: `tx-${authUserId}`,
      status: 'paid',
      rawWebhookEventId: webhookEventId,
      createdAt: now,
      updatedAt: now,
    });

    const membershipId = await ctx.db.insert('provider_memberships', {
      authUserId,
      providerConnectionId: connectionId,
      providerKey: 'jinxxy',
      externalMembershipId: `member-${authUserId}`,
      status: 'active',
      rawWebhookEventId: webhookEventId,
      createdAt: now,
      updatedAt: now,
    });

    const licenseId = await ctx.db.insert('provider_licenses', {
      authUserId,
      providerConnectionId: connectionId,
      providerKey: 'jinxxy',
      externalLicenseId: `license-${authUserId}`,
      status: 'active',
      rawWebhookEventId: webhookEventId,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert('entitlement_evidence', {
      authUserId,
      providerKey: 'jinxxy',
      providerConnectionId: connectionId,
      transactionId,
      membershipId,
      licenseId,
      sourceReference: `source-${authUserId}`,
      evidenceType: 'purchase',
      status: 'active',
      rawWebhookEventId: webhookEventId,
      observedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe('provider connection credential storage', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
  });

  it('given provider data for 2 creators, when destructive reset runs for one creator, then only that creator provider data is deleted', async () => {
    const t = makeTestConvex();

    await seedProviderResetFixture(t, 'auth-reset-a');
    await seedProviderResetFixture(t, 'auth-reset-b');

    expect(countSnapshot(await getProviderSnapshot(t, 'auth-reset-a'))).toEqual({
      providerConnections: 1,
      providerCredentials: 1,
      providerConnectionCapabilities: 1,
      providerCatalogMappings: 1,
      providerTransactions: 1,
      providerMemberships: 1,
      providerLicenses: 1,
      entitlementEvidence: 1,
      webhookEvents: 1,
    });

    await t.run(async (ctx) =>
      ctx.runMutation(internal.migrations.dangerouslyResetProviderDataForAuthUser, {
        authUserId: 'auth-reset-a',
      })
    );

    expect(countSnapshot(await getProviderSnapshot(t, 'auth-reset-a'))).toEqual({
      providerConnections: 0,
      providerCredentials: 0,
      providerConnectionCapabilities: 0,
      providerCatalogMappings: 0,
      providerTransactions: 0,
      providerMemberships: 0,
      providerLicenses: 0,
      entitlementEvidence: 0,
      webhookEvents: 0,
    });

    expect(countSnapshot(await getProviderSnapshot(t, 'auth-reset-b'))).toEqual({
      providerConnections: 1,
      providerCredentials: 1,
      providerConnectionCapabilities: 1,
      providerCatalogMappings: 1,
      providerTransactions: 1,
      providerMemberships: 1,
      providerLicenses: 1,
      entitlementEvidence: 1,
      webhookEvents: 1,
    });
  });

  it('given provider_connections insert with unknown credential field, when inserted directly, then schema rejects it', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    await expect(
      t.run(async (ctx) => {
        await ctx.db.insert('provider_connections', {
          authUserId: 'auth-schema-check',
          provider: 'jinxxy' as never,
          providerKey: 'jinxxy' as never,
          label: 'Jinxxy Store',
          connectionType: 'setup',
          status: 'active',
          authMode: 'api_key',
          webhookConfigured: false,
          // Credential fields must never live on provider_connections.
          /* biome-ignore lint/suspicious/noExplicitAny: intentional schema-violation test */
          ...({ someProviderTokenEncrypted: 'should-not-be-stored' } as any),
          createdAt: now,
          updatedAt: now,
        });
      })
    ).rejects.toThrow();
  });
});
