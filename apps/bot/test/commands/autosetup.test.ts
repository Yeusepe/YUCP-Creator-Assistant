/**
 * Tests for the autosetup command, specifically the migrate and roles flows.
 *
 * Bug: fetchAllProducts dropped the `error` field from listProviderProducts responses.
 * When a connected provider's credential expired, the API returned
 * { products: [], error: 'session_expired' }, silently ignored, and the user saw
 * "No products found / Connect Gumroad or Jinxxy first" even when connected.
 *
 * Note: providers that are simply not connected return
 * { products: [], error: "<provider> is not connected..." }, these are expected and
 * must NOT trigger the session-expired message.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { ConvexHttpClient } from 'convex/browser';
import {
  type ChatInputCommandInteraction,
  Collection,
  type StringSelectMenuInteraction,
} from 'discord.js';

const createSetupSessionTokenMock = mock(() => Promise.resolve('setup-token-123'));

// Controls what listProviderProducts returns for ALL providers in a test.
// Changed between tests before the call to handleAutosetupModeSelect.
let mockProductsResult: { products: Array<{ id: string; name: string }>; error?: string } = {
  products: [],
  error: undefined,
};

// Mock internalRpc BEFORE importing the command (bun:test hoists mock.module).
mock.module('../../src/lib/internalRpc', () => ({
  createSetupSessionToken: createSetupSessionTokenMock,
  listProviderProducts: mock((_provider: string, _authUserId: string) =>
    Promise.resolve({ ...mockProductsResult })
  ),
  createDiscordRoleSetupSessionToken: mock(() => Promise.resolve(undefined)),
  getDiscordRoleSetupResult: mock(() => Promise.resolve({ completed: false })),
  resolveVrchatAvatarName: mock(() => Promise.resolve({ name: undefined })),
  upsertProductCredential: mock(() => Promise.resolve({ success: true, error: undefined })),
}));

mock.module('../../src/lib/posthog', () => ({
  track: mock(() => {}),
}));

mock.module('../../../../convex/_generated/api', () => ({
  api: {
    setupJobs: {
      createOrResumeSetupJobForOwner: 'setupJobs:createOrResumeSetupJobForOwner',
    },
  },
}));

mock.module('../../src/lib/apiUrls', () => ({
  getApiUrls: mock(() => ({
    apiPublic: 'https://api.example.com',
    apiInternal: 'https://api-internal.example.com',
    webPublic: 'https://app.example.com',
  })),
}));

import type { Id } from '../../../../convex/_generated/dataModel';
import { handleAutosetupModeSelect, handleAutosetupStart } from '../../src/commands/autosetup';

const TEST_API_SECRET = 'test-api-secret';
const GUILD_LINK_ID = 'guild_link_autosetup_test' as Id<'guild_links'>;

const BASE_CTX = {
  authUserId: 'auth_autosetup_test',
  guildLinkId: GUILD_LINK_ID,
  guildId: 'guild_autosetup_test',
};

const MOCK_CONVEX = {
  query: mock(() => Promise.resolve({})),
  mutation: mock(() => Promise.resolve({ setupJobId: 'setup_job_123', created: true })),
  action: mock(() => Promise.resolve(undefined)),
} as unknown as ConvexHttpClient;

function mockStartInteraction(userId: string) {
  return {
    user: { id: userId, username: 'TestUser', displayName: 'TestUser', displayAvatarURL: () => '' },
    guild: {
      id: 'guild_autosetup_test',
      members: { me: { permissions: { has: () => true } } },
      roles: { fetch: mock(async () => new Collection()) },
    },
    deferReply: mock(async () => {}),
    editReply: mock(async () => {}),
    reply: mock(async () => {}),
    update: mock(async () => {}),
    followUp: mock(async () => {}),
    guildId: 'guild_autosetup_test',
  };
}

function mockModeSelectInteraction(userId: string, mode: string) {
  return {
    user: { id: userId, username: 'TestUser', displayName: 'TestUser', displayAvatarURL: () => '' },
    guild: {
      id: 'guild_autosetup_test',
      members: { me: { permissions: { has: () => true } } },
      roles: { fetch: mock(async () => new Collection()) },
    },
    values: [mode],
    deferUpdate: mock(async () => {}),
    editReply: mock(async () => {}),
    update: mock(async () => {}),
    followUp: mock(async () => {}),
    guildId: 'guild_autosetup_test',
  };
}

async function startSession(userId: string): Promise<void> {
  const interaction = mockStartInteraction(userId);
  await handleAutosetupStart(
    interaction as unknown as ChatInputCommandInteraction,
    MOCK_CONVEX,
    TEST_API_SECRET,
    BASE_CTX
  );
}

function lastReplyContent(editReply: ReturnType<typeof mock>): string {
  const calls = editReply.mock.calls;
  return JSON.stringify(calls[calls.length - 1][0]);
}

describe('autosetup launcher', () => {
  it('creates or resumes the durable setup job and returns a dashboard link', async () => {
    const interaction = mockStartInteraction('user_launch_1');

    await handleAutosetupStart(
      interaction as unknown as ChatInputCommandInteraction,
      MOCK_CONVEX,
      TEST_API_SECRET,
      BASE_CTX
    );

    expect((MOCK_CONVEX.mutation as ReturnType<typeof mock>).mock.calls[0]?.[1]).toEqual({
      apiSecret: TEST_API_SECRET,
      authUserId: BASE_CTX.authUserId,
      guildLinkId: BASE_CTX.guildLinkId,
      mode: 'automatic_setup',
      triggerSource: 'discord_autosetup',
    });
    expect(createSetupSessionTokenMock).toHaveBeenCalled();

    const [payload] = (interaction.editReply as ReturnType<typeof mock>).mock.calls[0] as [unknown];
    const serializedPayload = JSON.stringify(payload);
    expect(serializedPayload).toContain('Automatic setup started');
    expect(serializedPayload).toContain(
      'https://app.example.com/dashboard/setup?tenant_id=auth_autosetup_test&guild_id=guild_autosetup_test#s=setup-token-123'
    );
  });
});

// ─── migrate flow ─────────────────────────────────────────────────────────────

describe('autosetup migrate flow', () => {
  it('shows "connect a provider" when no products and no session_expired errors', async () => {
    // All providers simply not connected, expected state for a new user
    mockProductsResult = {
      products: [],
      error: 'gumroad is not connected. Connect it in your creator setup.',
    };

    await startSession('user_migrate_1');
    const interaction = mockModeSelectInteraction('user_migrate_1', 'migrate');
    await handleAutosetupModeSelect(
      interaction as unknown as StringSelectMenuInteraction,
      MOCK_CONVEX,
      TEST_API_SECRET,
      BASE_CTX.authUserId
    );

    const content = lastReplyContent(interaction.editReply as ReturnType<typeof mock>);
    expect(content).toContain('No products found');
    // Must NOT blame an expired session when the provider is simply unconnected
    expect(content).not.toContain('expired');
    expect(content).not.toContain('reconnect');
  });

  // FAILING TEST, reproduces the bug.
  // Current code shows "Connect Gumroad or Jinxxy first" instead of an expiry hint.
  it('shows session-expired hint when connected provider returns session_expired', async () => {
    mockProductsResult = { products: [], error: 'session_expired' };

    await startSession('user_migrate_2');
    const interaction = mockModeSelectInteraction('user_migrate_2', 'migrate');
    await handleAutosetupModeSelect(
      interaction as unknown as StringSelectMenuInteraction,
      MOCK_CONVEX,
      TEST_API_SECRET,
      BASE_CTX.authUserId
    );

    const content = lastReplyContent(interaction.editReply as ReturnType<typeof mock>);
    expect(content).toContain('No products found');
    // Should tell the user their connection expired, not to "connect Gumroad or Jinxxy first"
    expect(content).toContain('expired');
    expect(content).toContain('reconnect');
  });

  it('proceeds when products are returned (does not show no-products message)', async () => {
    mockProductsResult = { products: [{ id: 'prod_1', name: 'My Product' }], error: undefined };

    await startSession('user_migrate_3');
    const interaction = mockModeSelectInteraction('user_migrate_3', 'migrate');
    await handleAutosetupModeSelect(
      interaction as unknown as StringSelectMenuInteraction,
      MOCK_CONVEX,
      TEST_API_SECRET,
      BASE_CTX.authUserId
    );

    const content = JSON.stringify((interaction.editReply as ReturnType<typeof mock>).mock.calls);
    expect(content).not.toContain('No products found');
  });
});

// ─── roles flow ───────────────────────────────────────────────────────────────

describe('autosetup roles flow', () => {
  it('shows "connect a provider" when no products and no session_expired errors', async () => {
    mockProductsResult = {
      products: [],
      error: 'gumroad is not connected. Connect it in your creator setup.',
    };

    await startSession('user_roles_1');
    const interaction = mockModeSelectInteraction('user_roles_1', 'roles_only');
    await handleAutosetupModeSelect(
      interaction as unknown as StringSelectMenuInteraction,
      MOCK_CONVEX,
      TEST_API_SECRET,
      BASE_CTX.authUserId
    );

    const content = lastReplyContent(interaction.editReply as ReturnType<typeof mock>);
    expect(content).toContain('No products found');
    expect(content).not.toContain('expired');
    expect(content).not.toContain('reconnect');
  });

  // FAILING TEST, reproduces the bug.
  it('shows session-expired hint when connected provider returns session_expired', async () => {
    mockProductsResult = { products: [], error: 'session_expired' };

    await startSession('user_roles_2');
    const interaction = mockModeSelectInteraction('user_roles_2', 'roles_only');
    await handleAutosetupModeSelect(
      interaction as unknown as StringSelectMenuInteraction,
      MOCK_CONVEX,
      TEST_API_SECRET,
      BASE_CTX.authUserId
    );

    const content = lastReplyContent(interaction.editReply as ReturnType<typeof mock>);
    expect(content).toContain('No products found');
    expect(content).toContain('expired');
    expect(content).toContain('reconnect');
  });
});
