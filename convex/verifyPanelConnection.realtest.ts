/**
 * Regression: verify panel showed a verified buyer's linked account as
 * "not connected".
 *
 * Write side (account_link OAuth, e.g. "Sign in with Gumroad" from the Discord
 * verify panel): the binding is created under the BUYER's canonical authUserId
 * (subjects.ensureCanonicalAuthContextForDiscordUser).
 *
 * Former read side (apps/bot/src/commands/verify.ts fetchVerifyData) called
 * getSubjectWithAccounts with authUserId = guildLink.authUserId, i.e. the
 * CREATOR's authUserId. getSubjectWithAccounts filters
 * bindings by `binding.authUserId === effectiveAuthUserId`, so the buyer's
 * binding is filtered out -> found:false -> panel renders "nothing connected".
 *
 * This test seeds the exact post-verification records and asserts both the
 * legacy creator-scoped read and the correct buyer/subject-scoped read.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex } from './testHelpers';

const API_SECRET = 'test-convex-api-secret';
const BUYER_DISCORD_ID = 'buyer-discord-123';
const BUYER_AUTH = 'k57buyercanonical0000';
const CREATOR_AUTH = 'k57creatorowner000000';
const GUMROAD_USER_ID = 'gumroad-user-999';

async function seedVerifiedBuyer(t: ReturnType<typeof makeTestConvex>) {
  const now = Date.now();
  return t.run(async (ctx) => {
    const subjectId = await ctx.db.insert('subjects', {
      primaryDiscordUserId: BUYER_DISCORD_ID,
      authUserId: BUYER_AUTH,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    const externalAccountId = await ctx.db.insert('external_accounts', {
      provider: 'gumroad',
      providerUserId: GUMROAD_USER_ID,
      providerUsername: 'buyer',
      status: 'active',
      lastValidatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    // Binding owned by the BUYER's canonical authUserId, as the verification
    // write path (completeBuyerLinkSession -> activateBinding) creates it.
    await ctx.db.insert('bindings', {
      authUserId: BUYER_AUTH,
      subjectId,
      externalAccountId,
      bindingType: 'verification',
      status: 'active',
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    return { subjectId, externalAccountId };
  });
}

describe('verify panel connected-accounts scoping', () => {
  const original = process.env.CONVEX_API_SECRET;
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CONVEX_API_SECRET;
    else process.env.CONVEX_API_SECRET = original;
  });

  it('documents that a creator authUserId filter excludes buyer-owned accounts', async () => {
    const t = makeTestConvex();
    const { subjectId } = await seedVerifiedBuyer(t);

    // This reproduces the former fetchVerifyData bug: authUserId = creator.
    const result = await t.query(api.subjects.getSubjectWithAccounts, {
      apiSecret: API_SECRET,
      subjectId,
      authUserId: CREATOR_AUTH,
    });

    // Bug: the buyer's gumroad link is invisible -> panel says "not connected".
    expect(result.found).toBe(false);
    expect(result.externalAccounts).toHaveLength(0);
  });

  it('returns linked accounts when scoped to the buyer subject', async () => {
    const t = makeTestConvex();
    const { subjectId } = await seedVerifiedBuyer(t);

    // The fixed panel read scopes to the buyer's subject, not the creator's
    // authUserId. The test helper supplies a subjects:service actor, so the
    // no-filter query returns the buyer subject's active accounts.
    const result = await t.query(api.subjects.getSubjectWithAccounts, {
      apiSecret: API_SECRET,
      subjectId,
    });

    expect(result.found).toBe(true);
    const providers = result.externalAccounts.map((a) => a.provider);
    expect(providers).toContain('gumroad');
  });

  it('also returns linked accounts when scoped to the buyer auth user', async () => {
    const t = makeTestConvex();
    const { subjectId } = await seedVerifiedBuyer(t);

    const result = await t.query(api.subjects.getSubjectWithAccounts, {
      apiSecret: API_SECRET,
      subjectId,
      authUserId: BUYER_AUTH,
    });

    expect(result.found).toBe(true);
    expect(result.externalAccounts.map((a) => a.provider)).toContain('gumroad');
  });
});
