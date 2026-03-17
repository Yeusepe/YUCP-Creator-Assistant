/**
 * Tests for the verify command panel builder.
 *
 * buildVerifyStatusReply constructs a Discord ComponentsV2 container from Convex data.
 * We mock the ConvexHttpClient directly — no internalRpc calls happen during panel builds.
 *
 * Call-order note for the two "guild-only" convex queries:
 *   buildVerifyStatusReply runs Promise.all([fetchVerifyData(), convex.query(getEnabledProviders)])
 *   fetchVerifyData suspends at its FIRST await (getSubjectByDiscordId), so getEnabledProviders
 *   is invoked synchronously BEFORE fetchVerifyData's inner queries.
 *   Therefore among queries whose args match only {apiSecret, authUserId, guildId}:
 *     call index 1 → getEnabledVerificationProvidersFromProducts → return { providers }
 *     call index 2 → getByGuildWithProductNames (only when subject found) → return array
 */

import { describe, expect, it, mock } from 'bun:test';
import type { ConvexHttpClient } from 'convex/browser';
import { buildVerifyStatusReply } from '../../src/commands/verify';

// ─── Convex mock factory ──────────────────────────────────────────────────────

type ConvexMockOpts = {
  subjectFound?: boolean;
  linkedAccounts?: Array<{ provider: string; status: string; _id?: string }>;
  entitlements?: Array<{ productId: string }>;
  guildProducts?: Array<{ productId: string; displayName: string | null }>;
  providers?: string[];
  failedRoleSyncJobs?: unknown[];
};

function makeConvex(opts: ConvexMockOpts = {}): ConvexHttpClient {
  const {
    subjectFound = false,
    linkedAccounts = [],
    entitlements = [],
    guildProducts = [],
    providers = [],
    failedRoleSyncJobs = [],
  } = opts;

  let guildOnlyIdx = 0;

  return {
    query: mock(async (_ref: unknown, args: Record<string, unknown>) => {
      // getSubjectByDiscordId — has discordUserId but not guildId
      if ('discordUserId' in args && !('guildId' in args)) {
        if (!subjectFound) return { found: false };
        return { found: true, subject: { _id: 'subject_test_abc' } };
      }

      // getFailedRoleSyncForUser — has both discordUserId AND guildId
      if ('discordUserId' in args && 'guildId' in args) {
        return failedRoleSyncJobs;
      }

      // getEntitlementsBySubject — has subjectId and includeInactive
      if ('subjectId' in args && 'includeInactive' in args) {
        return entitlements;
      }

      // getSubjectWithAccounts — has subjectId only
      if ('subjectId' in args) {
        return { found: true, externalAccounts: linkedAccounts };
      }

      // Guild-only queries: getEnabledVerificationProvidersFromProducts (1st call)
      // and getByGuildWithProductNames (2nd call, only when subject is found).
      guildOnlyIdx++;
      if (guildOnlyIdx === 1) {
        return { providers };
      }
      return guildProducts;
    }),
    mutation: mock(async () => ({})),
  } as unknown as ConvexHttpClient;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildVerifyStatusReply', () => {
  it('shows setup-required message when no providers are configured for the guild', async () => {
    const convex = makeConvex({ subjectFound: false, providers: [] });

    const reply = await buildVerifyStatusReply(
      'user_verify_1',
      'auth_verify_1',
      'guild_verify_1',
      convex,
      'api-secret',
      'https://api.example.com'
    );

    const text = JSON.stringify(reply.components[0].toJSON());
    expect(text).toContain('Nothing to verify yet!');
  });

  it('shows verified state with product names when user has active entitlements in this guild', async () => {
    const convex = makeConvex({
      subjectFound: true,
      linkedAccounts: [{ provider: 'gumroad', status: 'active', _id: 'acct_1' }],
      entitlements: [{ productId: 'prod_verify_abc' }],
      guildProducts: [{ productId: 'prod_verify_abc', displayName: 'Awesome Course' }],
      providers: ['gumroad'],
      failedRoleSyncJobs: [],
    });

    const reply = await buildVerifyStatusReply(
      'user_verify_2',
      'auth_verify_2',
      'guild_verify_2',
      convex,
      'api-secret',
      'https://api.example.com'
    );

    const text = JSON.stringify(reply.components[0].toJSON());
    expect(text).toContain("You're verified!");
    expect(text).toContain('Awesome Course');
  });

  it('shows license-key verify button when user is unverified but providers are configured', async () => {
    // No subject found → state = 'nothing'; gumroad in enabledSet → license key button is shown
    const convex = makeConvex({ subjectFound: false, providers: ['gumroad'] });

    const reply = await buildVerifyStatusReply(
      'user_verify_3',
      'auth_verify_3',
      'guild_verify_3',
      convex,
      'api-secret',
      'https://api.example.com'
    );

    const text = JSON.stringify(reply.components[0].toJSON());
    // License key button uses a custom_id (not a URL), present regardless of apiBaseUrl
    expect(text).toContain('creator_verify:license:auth_verify_3');
  });

  it('handles DM context (null guildId) gracefully without throwing', async () => {
    // ⚠️ BUG: buildVerifyStatusReply does not validate that guildId is non-null.
    // DM interactions should receive a clear "use this in a server" error, but the function
    // proceeds with guildId=null and returns a "No products added" panel instead.
    // The assertion below expects a guild-required message — it will FAIL, revealing the bug.
    const convex = makeConvex({ subjectFound: false, providers: [] });

    const reply = await buildVerifyStatusReply(
      'user_verify_4',
      'auth_verify_4',
      null as unknown as string, // DM: no guild
      convex,
      'api-secret',
      undefined
    );

    const text = JSON.stringify(reply.components[0].toJSON());
    // ⚠️ BUG: returns "No products have been added" instead of a guild-required error
    expect(text).toContain('Use this command in a server');
  });
});
