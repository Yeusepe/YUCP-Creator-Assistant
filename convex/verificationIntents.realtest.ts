import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPinnedYucpRootsForTests } from '@yucp/shared/yucpTrust';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { getPublicKeyFromPrivate } from './lib/yucpCrypto';
import { makeTestConvex, seedSubject } from './testHelpers';

const API_SECRET = 'test-secret';

async function seedExternalAccount(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    provider?: string;
    providerUserId?: string;
    providerUsername?: string;
    status?: 'active' | 'disconnected' | 'revoked';
  } = {}
): Promise<Id<'external_accounts'>> {
  return t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert('external_accounts', {
      provider: overrides.provider ?? 'vrchat',
      providerUserId: overrides.providerUserId ?? `provider-user-${now}`,
      providerUsername: overrides.providerUsername,
      status: overrides.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return Buffer.from(new Uint8Array(digest))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('JWT must contain exactly three parts');
  }

  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')) as Record<string, unknown>;
}

async function configurePinnedTestRoot(): Promise<void> {
  const rootPrivateKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const rootPublicKey = await getPublicKeyFromPrivate(rootPrivateKey);
  process.env.YUCP_ROOT_KEY_ID = 'yucp-root';
  process.env.YUCP_ROOT_PRIVATE_KEY = rootPrivateKey;
  process.env.YUCP_ROOT_PUBLIC_KEY = rootPublicKey;
  setPinnedYucpRootsForTests([
    {
      keyId: 'yucp-root',
      algorithm: 'Ed25519',
      publicKeyBase64: rootPublicKey,
    },
  ]);
}

afterEach(() => {
  setPinnedYucpRootsForTests(null);
});

describe('verification intents buyer provider links', () => {
  beforeEach(async () => {
    process.env.CONVEX_API_SECRET = API_SECRET;
    process.env.CONVEX_SITE_URL = 'https://rare-squid-409.convex.site';
    await configurePinnedTestRoot();
  });

  it('verifies a buyer_provider_link requirement when the buyer has an active link', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-buyer-link-success';
    const subjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-buyer-link-success',
    });
    const externalAccountId = await seedExternalAccount(t, {
      provider: 'vrchat',
      providerUserId: 'vrchat-user-123',
      providerUsername: 'BuyerVR',
    });

    await t.mutation(api.subjects.upsertBuyerProviderLink, {
      apiSecret: API_SECRET,
      subjectId,
      provider: 'vrchat',
      externalAccountId,
      verificationMethod: 'account_link',
    });

    const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId,
      packageId: 'pkg-buyer-link',
      machineFingerprint: 'machine-success',
      codeChallenge: 'challenge-success',
      returnUrl: 'https://example.com/return',
      requirements: [
        {
          methodKey: 'vrchat-link',
          providerKey: 'vrchat',
          kind: 'buyer_provider_link',
          title: 'Linked VRChat account',
        },
      ],
    });

    const result = await t.action(api.verificationIntents.verifyIntentWithBuyerProviderLink, {
      apiSecret: API_SECRET,
      authUserId,
      intentId,
      methodKey: 'vrchat-link',
    });

    expect(result).toEqual({ success: true });

    const intent = await t.query(api.verificationIntents.getIntentRecord, {
      apiSecret: API_SECRET,
      authUserId,
      intentId,
    });

    expect(intent?.status).toBe('verified');
    expect(intent?.verifiedMethodKey).toBe('vrchat-link');
  });

  it('keeps the intent pending and reports provider_link_missing when no buyer link exists', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-buyer-link-missing';
    await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-buyer-link-missing',
    });

    const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId,
      packageId: 'pkg-buyer-link-missing',
      machineFingerprint: 'machine-missing',
      codeChallenge: 'challenge-missing',
      returnUrl: 'https://example.com/return',
      requirements: [
        {
          methodKey: 'vrchat-link',
          providerKey: 'vrchat',
          kind: 'buyer_provider_link',
          title: 'Linked VRChat account',
        },
      ],
    });

    const result = await t.action(api.verificationIntents.verifyIntentWithBuyerProviderLink, {
      apiSecret: API_SECRET,
      authUserId,
      intentId,
      methodKey: 'vrchat-link',
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('provider_link_missing');

    const intent = await t.query(api.verificationIntents.getIntentRecord, {
      apiSecret: API_SECRET,
      authUserId,
      intentId,
    });

    expect(intent?.status).toBe('pending');
    expect(intent?.errorCode).toBe('provider_link_missing');
  });

  it('lists and revokes buyer provider links for account surfaces', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-buyer-link-list';
    const subjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-buyer-link-list',
    });
    const externalAccountId = await seedExternalAccount(t, {
      provider: 'vrchat',
      providerUserId: 'vrchat-user-456',
      providerUsername: 'BuyerLink',
    });

    const linkId = await t.mutation(api.subjects.upsertBuyerProviderLink, {
      apiSecret: API_SECRET,
      subjectId,
      provider: 'vrchat',
      externalAccountId,
      verificationMethod: 'account_link',
    });

    const linksBeforeRevoke = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId,
    });

    expect(linksBeforeRevoke).toHaveLength(1);
    expect(linksBeforeRevoke[0]).toMatchObject({
      id: linkId,
      provider: 'vrchat',
      providerUserId: 'vrchat-user-456',
      providerUsername: 'BuyerLink',
      verificationMethod: 'account_link',
      status: 'active',
    });

    const revokeResult = await t.mutation(api.subjects.revokeBuyerProviderLink, {
      apiSecret: API_SECRET,
      authUserId,
      linkId,
    });

    expect(revokeResult.success).toBe(true);

    const linksAfterRevoke = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId,
    });
    expect(linksAfterRevoke).toHaveLength(0);
  });

  it('lists buyer provider links across every active subject for the auth user', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-buyer-link-multi-subject';
    const primarySubjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-buyer-link-primary',
    });
    const secondarySubjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-buyer-link-secondary',
    });

    const gumroadAccountId = await seedExternalAccount(t, {
      provider: 'gumroad',
      providerUserId: 'gumroad-user-123',
      providerUsername: 'PrimaryBuyer',
    });
    const jinxxyAccountId = await seedExternalAccount(t, {
      provider: 'jinxxy',
      providerUserId: 'jinxxy-user-456',
      providerUsername: 'SecondaryBuyer',
    });

    await t.mutation(api.subjects.upsertBuyerProviderLink, {
      apiSecret: API_SECRET,
      subjectId: primarySubjectId,
      provider: 'gumroad',
      externalAccountId: gumroadAccountId,
      verificationMethod: 'oauth',
    });
    await t.mutation(api.subjects.upsertBuyerProviderLink, {
      apiSecret: API_SECRET,
      subjectId: secondarySubjectId,
      provider: 'jinxxy',
      externalAccountId: jinxxyAccountId,
      verificationMethod: 'account_link',
    });

    const links = await t.query(api.subjects.listBuyerProviderLinksForAuthUser, {
      apiSecret: API_SECRET,
      authUserId,
    });

    expect(links.map((link: (typeof links)[number]) => link.provider).sort()).toEqual([
      'gumroad',
      'jinxxy',
    ]);
    expect(links.find((link: (typeof links)[number]) => link.provider === 'jinxxy')).toMatchObject({
      providerUserId: 'jinxxy-user-456',
      providerUsername: 'SecondaryBuyer',
      verificationMethod: 'account_link',
      status: 'active',
    });
  });
});

describe('verification intents redemption issuer', () => {
  beforeEach(async () => {
    process.env.CONVEX_API_SECRET = API_SECRET;
    process.env.CONVEX_SITE_URL = 'https://rare-squid-409.convex.site';
    await configurePinnedTestRoot();
  });

  it('mints the license token for the caller public origin instead of the convex site origin', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-redemption-issuer';
    const codeVerifier = 'code-verifier-redemption-issuer';
    const codeChallenge = await computeCodeChallenge(codeVerifier);
    const publicIssuerBaseUrl = 'https://public-api.test.example';

    await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-redemption-issuer',
    });

    const { intentId } = await t.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId,
      packageId: 'pkg-redemption-issuer',
      packageName: 'Issuer Test Package',
      machineFingerprint: 'machine-redemption-issuer',
      codeChallenge,
      returnUrl: 'http://127.0.0.1:51515/callback',
      requirements: [
        {
          methodKey: 'vrchat-link',
          providerKey: 'vrchat',
          kind: 'buyer_provider_link',
          title: 'Linked VRChat buyer account',
        },
      ],
    });

    await t.mutation(internal.verificationIntents.markIntentVerified, {
      intentId,
      methodKey: 'vrchat-link',
    });

    const intent = await t.action(api.verificationIntents.getVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId,
      intentId,
    });

    const grantToken = intent?.grantToken;
    expect(grantToken).toBeTruthy();
    if (!grantToken) {
      throw new Error('Expected verification intent grant token');
    }

    const redemption = await t.action(api.verificationIntents.redeemVerificationIntent, {
      apiSecret: API_SECRET,
      authUserId,
      intentId,
      codeVerifier,
      machineFingerprint: 'machine-redemption-issuer',
      grantToken,
      issuerBaseUrl: publicIssuerBaseUrl,
    });

    expect(redemption.success).toBe(true);
    const redemptionToken = redemption.token;
    expect(redemptionToken).toBeTruthy();
    if (!redemptionToken) {
      throw new Error('Expected redeemed verification token');
    }

    const payload = decodeJwtPayload(redemptionToken);
    expect(payload.iss).toBe(`${publicIssuerBaseUrl}/api/auth`);
    expect(payload.iss).not.toBe('https://rare-squid-409.convex.site/api/auth');
  });
});
