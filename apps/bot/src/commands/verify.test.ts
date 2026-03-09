import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { handleRefreshCommand, handleVerifyStartButton } from './verify';

const originalWarn = console.warn;
const originalErrorReferenceSecret = process.env.ERROR_REFERENCE_SECRET;

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
      interaction as any,
      convex as any,
      'api-secret',
      'https://api.example.com',
      { tenantId: 'tenant_123' as any, guildId: 'guild_123' }
    );

    const message = editReply.mock.calls[0]?.[0]?.content;
    expect(message).toContain('Support code:');
    const supportCode = message.match(/Support code: `([^`]+)`/)?.[1];
    expect(supportCode).toBeTruthy();

    const loggedSupportCode = ((warnMock.mock.calls as unknown) as Array<[string, Record<string, unknown>?]>)
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
      interaction as any,
      convex as any,
      'api-secret',
      { tenantId: 'tenant_456' as any }
    );

    const message = editReply.mock.calls[0]?.[0]?.content;
    expect(message).toContain('Support code:');
    const supportCode = message.match(/Support code: `([^`]+)`/)?.[1];
    expect(supportCode).toBeTruthy();

    const loggedSupportCode = ((warnMock.mock.calls as unknown) as Array<[string, Record<string, unknown>?]>)
      .map((call) => call[1] as Record<string, unknown> | undefined)
      .find((meta) => meta?.supportCode)?.supportCode;
    expect(loggedSupportCode).toBe(supportCode);
  });
});
