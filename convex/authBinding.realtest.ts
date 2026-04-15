import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { makeTestConvex, seedEntitlement, seedGuildLink, seedSubject } from './testHelpers';

const API_SECRET = 'test-secret';
const INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';

async function seedPackageRegistration(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    packageId?: string;
    packageName?: string;
    publisherId?: string;
    yucpUserId?: string;
    status?: 'active' | 'archived';
  } = {}
): Promise<void> {
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert('package_registry', {
      packageId: overrides.packageId ?? `pkg.${now}`,
      packageName: overrides.packageName ?? 'Test Package',
      publisherId: overrides.publisherId ?? 'publisher-test',
      yucpUserId: overrides.yucpUserId ?? 'auth-package-owner',
      status: overrides.status ?? 'active',
      registeredAt: now,
      updatedAt: now,
    });
  });
}

async function seedManualLicense(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    authUserId?: string;
    licenseKeyHash?: string;
    productId?: string;
    status?: 'active' | 'revoked' | 'expired' | 'exhausted';
  } = {}
): Promise<Id<'manual_licenses'>> {
  const now = Date.now();
  return await t.run(async (ctx) => {
    return await ctx.db.insert('manual_licenses', {
      authUserId: overrides.authUserId ?? 'auth-license-owner',
      licenseKeyHash: overrides.licenseKeyHash ?? 'license-hash-test',
      productId: overrides.productId ?? 'product-license-test',
      currentUses: 0,
      status: overrides.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedExternalAccount(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    provider?:
      | 'discord'
      | 'gumroad'
      | 'jinxxy'
      | 'manual'
      | 'itchio'
      | 'payhip'
      | 'lemonsqueezy'
      | 'vrchat';
    providerUserId?: string;
  } = {}
): Promise<Id<'external_accounts'>> {
  const now = Date.now();
  return await t.run(async (ctx) => {
    return await ctx.db.insert('external_accounts', {
      provider: overrides.provider ?? 'discord',
      providerUserId: overrides.providerUserId ?? `provider-user-${now}`,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedBinding(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    authUserId?: string;
    subjectId: Id<'subjects'>;
    externalAccountId: Id<'external_accounts'>;
    bindingType?: 'ownership' | 'verification' | 'manual_override';
    status?: 'active' | 'pending' | 'revoked' | 'quarantined' | 'transferred';
  }
): Promise<Id<'bindings'>> {
  const now = Date.now();
  return await t.run(async (ctx) => {
    return await ctx.db.insert('bindings', {
      authUserId: overrides.authUserId ?? 'auth-binding-owner',
      subjectId: overrides.subjectId,
      externalAccountId: overrides.externalAccountId,
      bindingType: overrides.bindingType ?? 'verification',
      status: overrides.status ?? 'active',
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedDownloadRoute(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    authUserId?: string;
    guildId?: string;
    guildLinkId: Id<'guild_links'>;
    sourceChannelId?: string;
    archiveChannelId?: string;
  }
): Promise<Id<'download_routes'>> {
  const now = Date.now();
  return await t.run(async (ctx) => {
    return await ctx.db.insert('download_routes', {
      authUserId: overrides.authUserId ?? 'auth-download-owner',
      guildId: overrides.guildId ?? 'guild-download-test',
      guildLinkId: overrides.guildLinkId,
      sourceChannelId: overrides.sourceChannelId ?? 'channel-source-test',
      archiveChannelId: overrides.archiveChannelId ?? 'channel-archive-test',
      messageTitle: 'Downloads',
      messageBody: 'Protected downloads',
      requiredRoleIds: ['role-download-test'],
      roleLogic: 'all',
      allowedExtensions: ['zip'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedDownloadArtifact(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    authUserId?: string;
    guildId?: string;
    routeId: Id<'download_routes'>;
    sourceChannelId?: string;
    sourceMessageId?: string;
  }
): Promise<Id<'download_artifacts'>> {
  const now = Date.now();
  return await t.run(async (ctx) => {
    return await ctx.db.insert('download_artifacts', {
      authUserId: overrides.authUserId ?? 'auth-download-owner',
      guildId: overrides.guildId ?? 'guild-download-test',
      routeId: overrides.routeId,
      sourceChannelId: overrides.sourceChannelId ?? 'channel-source-test',
      sourceMessageId: overrides.sourceMessageId ?? 'message-source-test',
      sourceMessageUrl: 'https://discord.test/messages/source',
      sourceAuthorId: 'discord-author-test',
      archiveChannelId: 'channel-archive-test',
      archiveMessageId: 'message-archive-test',
      requiredRoleIds: ['role-download-test'],
      roleLogic: 'all',
      files: [
        {
          filename: 'archive.zip',
          url: 'https://downloads.test/archive.zip',
          extension: 'zip',
        },
      ],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedVerificationIntent(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    authUserId?: string;
    packageId?: string;
    status?: 'pending' | 'verified' | 'redeemed' | 'expired' | 'cancelled';
  } = {}
): Promise<Id<'verification_intents'>> {
  const now = Date.now();
  return await t.run(async (ctx) => {
    return await ctx.db.insert('verification_intents', {
      authUserId: overrides.authUserId ?? 'auth-intent-owner',
      packageId: overrides.packageId ?? 'pkg.intent-test',
      machineFingerprint: 'machine-fingerprint-test',
      codeChallenge: 'code-challenge-test',
      returnUrl: 'https://creator.example.com/verify',
      requirements: [],
      status: overrides.status ?? 'pending',
      expiresAt: now + 60_000,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedVerificationSession(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    authUserId?: string;
    state?: string;
    nonce?: string;
  } = {}
): Promise<Id<'verification_sessions'>> {
  const now = Date.now();
  return await t.run(async (ctx) => {
    return await ctx.db.insert('verification_sessions', {
      authUserId: overrides.authUserId ?? 'auth-session-owner',
      mode: 'gumroad',
      verificationMethod: 'gumroad',
      state: overrides.state ?? 'state-session-test',
      redirectUri: 'https://creator.example.com/callback',
      nonce: overrides.nonce ?? 'nonce-session-test',
      expiresAt: now + 60_000,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe('auth binding enforcement', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
    process.env.INTERNAL_SERVICE_AUTH_SECRET = INTERNAL_SERVICE_AUTH_SECRET;
  });

  afterEach(() => {
    delete process.env.CONVEX_API_SECRET;
    delete process.env.INTERNAL_SERVICE_AUTH_SECRET;
  });

  it('rejects listing package registrations without an actor binding', async () => {
    const t = makeTestConvex({ injectActor: false });
    await seedPackageRegistration(t, { yucpUserId: 'auth-package-owner' });

    await expect(
      t.query(api.packageRegistry.listForAuthUser, {
        apiSecret: API_SECRET,
        authUserId: 'auth-package-owner',
      })
    ).rejects.toThrow(/actor|unauthorized/i);
  });

  it('preserves an explicitly provided invalid actor binding in test helpers', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t, { yucpUserId: 'auth-package-owner' });

    await expect(
      t.query(api.packageRegistry.listByAuthUser, {
        apiSecret: API_SECRET,
        authUserId: 'auth-package-owner',
        actor: {
          payload: 'not-a-valid-payload',
          signature: 'not-a-valid-signature',
        },
      })
    ).rejects.toThrow(/actor|unauthorized/i);
  });

  it('rejects entitlement lookups without an actor binding', async () => {
    const t = makeTestConvex({ injectActor: false });
    const subjectId = await seedSubject(t, { authUserId: 'auth-entitlement-owner' });
    await seedEntitlement(t, subjectId, {
      authUserId: 'auth-entitlement-owner',
      productId: 'product-entitlement-test',
    });

    await expect(
      t.query(api.entitlements.getEntitlementsBySubject, {
        apiSecret: API_SECRET,
        authUserId: 'auth-entitlement-owner',
        subjectId,
        includeInactive: false,
      })
    ).rejects.toThrow(/actor|unauthorized/i);
  });

  it('rejects manual license hash lookups without an actor binding', async () => {
    const t = makeTestConvex({ injectActor: false });
    await seedManualLicense(t, {
      authUserId: 'auth-license-owner',
      licenseKeyHash: 'license-hash-enforced',
    });

    await expect(
      t.query(api.manualLicenses.findByKeyHash, {
        apiSecret: API_SECRET,
        licenseKeyHash: 'license-hash-enforced',
      })
    ).rejects.toThrow(/actor|unauthorized/i);
  });

  it('rejects subject lookup by discord id without an actor binding', async () => {
    const t = makeTestConvex({ injectActor: false });
    await seedSubject(t, {
      authUserId: 'auth-subject-owner',
      primaryDiscordUserId: 'discord-subject-owner',
    });

    await expect(
      t.query(api.subjects.getSubjectByDiscordId, {
        apiSecret: API_SECRET,
        discordUserId: 'discord-subject-owner',
      })
    ).rejects.toThrow(/actor|unauthorized/i);
  });

  it('rejects subject account expansion without an actor binding', async () => {
    const t = makeTestConvex({ injectActor: false });
    const subjectId = await seedSubject(t, {
      authUserId: 'auth-subject-owner',
      primaryDiscordUserId: 'discord-subject-owner',
    });
    const externalAccountId = await seedExternalAccount(t, {
      providerUserId: 'discord-linked-owner',
    });
    await seedBinding(t, {
      authUserId: 'auth-subject-owner',
      subjectId,
      externalAccountId,
    });

    await expect(
      t.query(api.subjects.getSubjectWithAccounts, {
        apiSecret: API_SECRET,
        subjectId,
      })
    ).rejects.toThrow(/actor|unauthorized/i);
  });

  it('rejects active route lookups without an actor binding', async () => {
    const t = makeTestConvex({ injectActor: false });
    const guildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-download-owner',
      discordGuildId: 'guild-download-test',
    });
    await seedDownloadRoute(t, {
      authUserId: 'auth-download-owner',
      guildId: 'guild-download-test',
      guildLinkId,
      sourceChannelId: 'channel-source-test',
    });

    await expect(
      t.query(api.downloads.getActiveRoutesForChannel, {
        apiSecret: API_SECRET,
        guildId: 'guild-download-test',
        channelIds: ['channel-source-test'],
      })
    ).rejects.toThrow(/actor|unauthorized/i);
  });

  it('rejects artifact delivery lookups without an actor binding', async () => {
    const t = makeTestConvex({ injectActor: false });
    const guildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-download-owner',
      discordGuildId: 'guild-download-test',
    });
    const routeId = await seedDownloadRoute(t, {
      authUserId: 'auth-download-owner',
      guildId: 'guild-download-test',
      guildLinkId,
    });
    const artifactId = await seedDownloadArtifact(t, {
      authUserId: 'auth-download-owner',
      guildId: 'guild-download-test',
      routeId,
      sourceMessageId: 'artifact-source-message',
    });

    await expect(
      t.query(api.downloads.getArtifactForDelivery, {
        apiSecret: API_SECRET,
        artifactId,
      })
    ).rejects.toThrow(/actor|unauthorized/i);
  });

  it('rejects intent diagnostics without an actor binding', async () => {
    const t = makeTestConvex({ injectActor: false });
    const intentId = await seedVerificationIntent(t, {
      authUserId: 'auth-intent-owner',
      packageId: 'pkg.intent-owner',
    });

    await expect(
      t.query(api.verificationIntents.getIntentAccessDiagnostic, {
        apiSecret: API_SECRET,
        intentId,
      })
    ).rejects.toThrow(/actor|unauthorized/i);
  });

  it('rejects verification session lookup by state without an actor binding', async () => {
    const t = makeTestConvex({ injectActor: false });
    await seedVerificationSession(t, {
      authUserId: 'auth-session-owner',
      state: 'verification-state-owner',
    });

    await expect(
      t.query(api.verificationSessions.getVerificationSessionByState, {
        apiSecret: API_SECRET,
        authUserId: 'auth-session-owner',
        state: 'verification-state-owner',
      })
    ).rejects.toThrow(/actor|unauthorized/i);
  });

  it('rejects verification session completion without an actor binding', async () => {
    const t = makeTestConvex({ injectActor: false });
    const subjectId = await seedSubject(t, {
      authUserId: 'auth-session-owner',
      primaryDiscordUserId: 'discord-session-owner',
    });
    const sessionId = await seedVerificationSession(t, {
      authUserId: 'auth-session-owner',
      state: 'verification-state-complete',
    });

    await expect(
      t.mutation(api.verificationSessions.completeVerificationSession, {
        apiSecret: API_SECRET,
        sessionId,
        subjectId,
      })
    ).rejects.toThrow(/actor|unauthorized/i);
  });
});
