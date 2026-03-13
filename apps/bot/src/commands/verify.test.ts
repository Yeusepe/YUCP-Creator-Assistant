import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { buildVerifyStatusReply, handleRefreshCommand, handleVerifyStartButton } from './verify';

const originalWarn = console.warn;
const originalErrorReferenceSecret = process.env.ERROR_REFERENCE_SECRET;
type VerifyStartInteraction = Parameters<typeof handleVerifyStartButton>[0];
type VerifyStartConvex = Parameters<typeof handleVerifyStartButton>[1];
type RefreshInteraction = Parameters<typeof handleRefreshCommand>[0];
type RefreshConvex = Parameters<typeof handleRefreshCommand>[1];
type VerifyStatusConvex = Parameters<typeof buildVerifyStatusReply>[3];

describe('verification support codes in bot handlers', () => {
  beforeEach(() => {
    process.env.ERROR_REFERENCE_SECRET = 'bot-test-support-secret';
  });

  afterEach(() => {
    console.warn = originalWarn;
    process.env.ERROR_REFERENCE_SECRET = originalErrorReferenceSecret;
  });

  it('includes a support code and logs the same code when verify panel load fails', async () => {
    const warnMock = mock(() => {});
    console.warn = warnMock as typeof console.warn;
    const editReply = mock(async (payload: { content: string }) => payload);

    const interaction = {
      applicationId: 'app_123',
      deferReply: mock(async () => {}),
      editReply,
      followUp: mock(async () => {}),
      guildId: 'guild_123',
      token: 'token_123',
      user: {
        id: 'user_123',
      },
    };

    const convex = {
      query: mock(async () => {
        throw new Error('verify panel exploded');
      }),
    };

    await handleVerifyStartButton(
      interaction as unknown as VerifyStartInteraction,
      convex as unknown as VerifyStartConvex,
      'api-secret',
      'https://api.example.com',
      { authUserId: 'user_abc123' as string, guildId: 'guild_123' }
    );

    const message = editReply.mock.calls[0]?.[0]?.content;
    expect(message).toContain('Support code:');
    const supportCode = message.match(/Support code: `([^`]+)`/)?.[1];
    expect(supportCode).toBeTruthy();

    const loggedSupportCode = (
      warnMock.mock.calls as unknown as Array<[string, Record<string, unknown>?]>
    )
      .map((call) => call[1] as Record<string, unknown> | undefined)
      .find((meta) => meta?.supportCode)?.supportCode;
    expect(loggedSupportCode).toBe(supportCode);
  });

  it('includes a support code and logs the same code when refresh fails', async () => {
    const warnMock = mock(() => {});
    console.warn = warnMock as typeof console.warn;
    const editReply = mock(async (payload: { content: string }) => payload);

    const interaction = {
      deferReply: mock(async () => {}),
      editReply,
      guildId: 'guild_456',
      user: {
        id: 'user_456',
      },
    };

    const convex = {
      mutation: mock(async () => {
        throw new Error('role sync queue unavailable');
      }),
    };

    await handleRefreshCommand(
      interaction as unknown as RefreshInteraction,
      convex as unknown as RefreshConvex,
      'api-secret',
      {
        authUserId: 'user_abc456' as string,
      }
    );

    const message = editReply.mock.calls[0]?.[0]?.content;
    expect(message).toContain('Support code:');
    const supportCode = message.match(/Support code: `([^`]+)`/)?.[1];
    expect(supportCode).toBeTruthy();

    const loggedSupportCode = (
      warnMock.mock.calls as unknown as Array<[string, Record<string, unknown>?]>
    )
      .map((call) => call[1] as Record<string, unknown> | undefined)
      .find((meta) => meta?.supportCode)?.supportCode;
    expect(loggedSupportCode).toBe(supportCode);
  });

  it('renders safely after duplicate cleanup while preserving distinct same-provider accounts', async () => {
    const mutation = mock(async () => ({
      duplicateGroups: 1,
      removedBindings: 1,
      removedExternalAccounts: 1,
    }));
    const convex = {
      mutation,
      query: mock(async (_ref: unknown, args: Record<string, unknown>) => {
        if ('discordUserId' in args) {
          return {
            found: true,
            subject: { _id: 'subject_123' },
          };
        }

        if ('subjectId' in args && 'includeInactive' in args) {
          return [{ productId: 'product_123' }];
        }

        if ('subjectId' in args) {
          return {
            found: true,
            externalAccounts: [
              { _id: 'acct_1', provider: 'gumroad', providerUserId: 'gumroad_1', status: 'active' },
              { _id: 'acct_2', provider: 'gumroad', providerUserId: 'gumroad_2', status: 'active' },
              { provider: 'discord', status: 'active' },
            ],
          };
        }

        if ('apiSecret' in args && 'guildId' in args) {
          return {
            gumroad: true,
            jinxxy: false,
            discord: true,
            vrchat: false,
          };
        }

        return [{ productId: 'product_123', displayName: 'My Product' }];
      }),
    };

    const reply = await buildVerifyStatusReply(
      'user_123',
      'user_test123' as string,
      'guild_123',
      convex as unknown as VerifyStatusConvex,
      'api-secret',
      'https://api.example.com'
    );

    const json = reply.components[0].toJSON() as {
      components?: Array<{ components?: Array<{ custom_id?: string; content?: string }> }>;
    };
    const customIds = (json.components ?? [])
      .flatMap((component) => component.components ?? [])
      .map((component) => component.custom_id)
      .filter((value): value is string => typeof value === 'string');
    const textContent = JSON.stringify(json);

    expect(customIds.filter((id) => id === 'creator_verify:disconnect:gumroad')).toHaveLength(1);
    expect(new Set(customIds).size).toBe(customIds.length);
    expect(textContent).toContain('2 accounts connected');
    expect(mutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        apiSecret: 'api-secret',
        subjectId: 'subject_123',
        authUserId: 'user_test123',
      })
    );
  });
});
