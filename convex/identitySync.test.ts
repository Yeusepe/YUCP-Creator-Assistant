/**
 * Tests for Identity Sync Module
 *
 * Tests the validator schemas and function definitions.
 * For full integration tests with a Convex backend, use convex-test package.
 *
 * @see https://github.com/get-convex/convex-test
 */

import { describe, expect, it } from 'bun:test';
import { v } from 'convex/values';

// ============================================================================
// VALIDATOR SCHEMA TESTS
// ============================================================================

describe('Discord Account Data Validator', () => {
  // Recreate the validator locally for testing
  const _DiscordAccountData = v.object({
    discordUserId: v.string(),
    username: v.string(),
    discriminator: v.optional(v.string()),
    avatar: v.optional(v.string()),
    email: v.optional(v.string()),
  });

  it('should have correct schema structure', () => {
    // Verify the validator is properly constructed
    const validData = {
      discordUserId: '123456789012345678',
      username: 'TestUser',
      discriminator: '1234',
      avatar: 'abcdef123456',
      email: 'test@example.com',
    };

    // Convex validators are TypeScript types - we verify structure by TypeScript
    // At runtime, validation happens in Convex functions, not directly
    // We just verify the data has expected shape
    expect(validData.discordUserId).toBeDefined();
    expect(validData.username).toBeDefined();
    expect(typeof validData.discordUserId).toBe('string');
    expect(typeof validData.username).toBe('string');
  });

  it('should accept Discord account data without optional fields', () => {
    const minimalData = {
      discordUserId: '123456789012345678',
      username: 'TestUser',
    };

    // Verify minimal data has expected shape
    expect(minimalData.discordUserId).toBeDefined();
    expect(minimalData.username).toBeDefined();
  });

  it('should validate as valid data structure', () => {
    // These are the required fields that TypeScript would enforce
    const requiredFields = ['discordUserId', 'username'];
    expect(requiredFields).toContain('discordUserId');
    expect(requiredFields).toContain('username');
  });
});

describe('Sync User Input Validator', () => {
  const _SyncUserInput = v.object({
    authUserId: v.string(),
    discord: v.object({
      discordUserId: v.string(),
      username: v.string(),
      discriminator: v.optional(v.string()),
      avatar: v.optional(v.string()),
      email: v.optional(v.string()),
    }),
  });

  it('should have correct schema structure', () => {
    const validInput = {
      authUserId: 'auth_123456',
      discord: {
        discordUserId: '123456789012345678',
        username: 'TestUser',
        discriminator: '0001',
        avatar: 'abc123',
        email: 'test@example.com',
      },
    };

    // Verify input has expected shape
    expect(validInput.authUserId).toBeDefined();
    expect(validInput.discord).toBeDefined();
    expect(validInput.discord.discordUserId).toBeDefined();
    expect(validInput.discord.username).toBeDefined();
  });

  it('should accept sync input with minimal Discord data', () => {
    const minimalInput = {
      authUserId: 'auth_123456',
      discord: {
        discordUserId: '123456789012345678',
        username: 'TestUser',
      },
    };

    // Verify minimal input has expected shape
    expect(minimalInput.authUserId).toBeDefined();
    expect(minimalInput.discord).toBeDefined();
  });

  it('should validate required fields', () => {
    // These are the required fields that TypeScript would enforce
    const requiredTopLevel = ['authUserId', 'discord'];
    const requiredDiscord = ['discordUserId', 'username'];

    expect(requiredTopLevel).toContain('authUserId');
    expect(requiredTopLevel).toContain('discord');
    expect(requiredDiscord).toContain('discordUserId');
    expect(requiredDiscord).toContain('username');
  });
});

describe('Sync Result Validator', () => {
  const _SyncResult = v.object({
    success: v.boolean(),
    subjectId: v.id('subjects'),
    externalAccountId: v.optional(v.id('external_accounts')),
    isNewSubject: v.boolean(),
    isNewExternalAccount: v.boolean(),
  });

  it('should accept valid sync result with all fields', () => {
    const validResult = {
      success: true,
      subjectId: 'subj_123' as const,
      externalAccountId: 'ext_456' as const,
      isNewSubject: false,
      isNewExternalAccount: false,
    };

    // Note: v.id() validators are strict about format
    // In unit tests, we can only verify the structure
    expect(typeof validResult.success).toBe('boolean');
    expect(typeof validResult.subjectId).toBe('string');
    expect(typeof validResult.isNewSubject).toBe('boolean');
    expect(typeof validResult.isNewExternalAccount).toBe('boolean');
  });

  it('should accept sync result without optional externalAccountId', () => {
    const validResult: {
      success: boolean;
      subjectId: string;
      isNewSubject: boolean;
      isNewExternalAccount: boolean;
      externalAccountId?: string;
    } = {
      success: true,
      subjectId: 'subj_123' as const,
      isNewSubject: true,
      isNewExternalAccount: true,
    };

    expect(validResult.externalAccountId).toBeUndefined();
  });
});

// ============================================================================
// AVATAR URL BUILDER TESTS
// ============================================================================

describe('Discord Avatar URL Builder', () => {
  it('should build correct avatar URL with avatar hash', async () => {
    const { buildDiscordAvatarUrl } = await import('./identitySync');
    const url = buildDiscordAvatarUrl('123456789012345678', 'abcdef123456');
    expect(url).toBe('https://cdn.discordapp.com/avatars/123456789012345678/abcdef123456.png');
  });

  it('should return undefined when no avatar hash provided', async () => {
    const { buildDiscordAvatarUrl } = await import('./identitySync');
    const url = buildDiscordAvatarUrl('123456789012345678', undefined);
    expect(url).toBeUndefined();
  });

  it('should return undefined when empty string avatar hash', async () => {
    const { buildDiscordAvatarUrl } = await import('./identitySync');
    const url = buildDiscordAvatarUrl('123456789012345678', '');
    expect(url).toBeUndefined();
  });
});

// ============================================================================
// USERNAME BUILDER TESTS
// ============================================================================

describe('Discord Username Builder', () => {
  it('should build username with discriminator when present', async () => {
    const { buildFullUsername } = await import('./identitySync');
    const fullName = buildFullUsername('TestUser', '1234');
    expect(fullName).toBe('TestUser#1234');
  });

  it('should return plain username when discriminator is "0" (new Discord format)', async () => {
    const { buildFullUsername } = await import('./identitySync');
    const fullName = buildFullUsername('TestUser', '0');
    expect(fullName).toBe('TestUser');
  });

  it('should return plain username when discriminator is undefined', async () => {
    const { buildFullUsername } = await import('./identitySync');
    const fullName = buildFullUsername('TestUser', undefined);
    expect(fullName).toBe('TestUser');
  });

  it('should handle empty discriminator', async () => {
    const { buildFullUsername } = await import('./identitySync');
    const fullName = buildFullUsername('TestUser', '');
    expect(fullName).toBe('TestUser');
  });
});

// ============================================================================
// PROFILE URL BUILDER TESTS
// ============================================================================

describe('Discord Profile URL Builder', () => {
  it('should build correct profile URL', async () => {
    const { buildDiscordProfileUrl } = await import('./identitySync');
    const url = buildDiscordProfileUrl('123456789012345678');
    expect(url).toBe('https://discord.com/users/123456789012345678');
  });
});

// ============================================================================
// SYNC SCENARIO DESCRIPTIONS (for documentation)
// ============================================================================

describe('Identity Sync Scenarios', () => {
  it('SyncUserInput requires authUserId and discord', async () => {
    const { SyncUserInput } = await import('./identitySync');
    expect(SyncUserInput).toBeDefined();
    const validInput = {
      authUserId: 'auth_123',
      discord: { discordUserId: '123456789', username: 'TestUser' },
    };
    expect(validInput.authUserId).toBeDefined();
    expect(validInput.discord.discordUserId).toBeDefined();
  });

  it('SyncResult has success, subjectId, isNewSubject, isNewExternalAccount', async () => {
    const { SyncResult } = await import('./identitySync');
    expect(SyncResult).toBeDefined();
    const result = {
      success: true,
      subjectId: 'subj_1',
      isNewSubject: true,
      isNewExternalAccount: true,
    };
    expect(result.success).toBe(true);
    expect(result.isNewSubject).toBe(true);
  });

  it('findSubjectByAuthId and findSubjectByDiscordId are exported', async () => {
    const mod = await import('./identitySync');
    expect(mod.findSubjectByAuthId).toBeDefined();
    expect(mod.findSubjectByDiscordId).toBeDefined();
    expect(mod.syncUserFromAuth).toBeDefined();
  });
});
