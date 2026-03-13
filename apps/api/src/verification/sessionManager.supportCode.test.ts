import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { type VerificationConfig, createVerificationRoutes } from './sessionManager';

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const originalErrorReferenceSecret = process.env.ERROR_REFERENCE_SECRET;

const testConfig: VerificationConfig = {
  baseUrl: 'https://api.example.com',
  frontendUrl: 'https://app.example.com',
  convexUrl: '',
  convexApiSecret: 'api-secret',
  gumroadClientId: 'gumroad-client-id',
  gumroadClientSecret: 'gumroad-client-secret',
};

describe('verification support codes in api routes', () => {
  beforeEach(() => {
    process.env.ERROR_REFERENCE_SECRET = 'api-test-support-secret';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    process.env.ERROR_REFERENCE_SECRET = originalErrorReferenceSecret;
  });

  it('returns and logs a support code when verify panel refresh fails at Discord', async () => {
    const warnMock = mock(() => {});
    console.warn = warnMock as typeof console.warn;
    globalThis.fetch = mock(
      async () => new Response('discord failed', { status: 502 })
    ) as unknown as typeof fetch;

    const routes = createVerificationRoutes(testConfig);

    await routes.bindVerifyPanel(
      new Request('https://api.example.com/api/verification/panel/bind', {
        body: JSON.stringify({
          apiSecret: 'api-secret',
          applicationId: 'app_123',
          discordUserId: 'user_123',
          guildId: 'guild_123',
          interactionToken: 'token_123',
          messageId: 'message_123',
          panelToken: 'panel_123',
          authUserId: 'user_test123',
        }),
        headers: {
          'content-type': 'application/json',
        },
        method: 'POST',
      })
    );

    const response = await routes.refreshVerifyPanel(
      new Request('https://api.example.com/api/verification/panel/refresh', {
        body: JSON.stringify({
          panelToken: 'panel_123',
        }),
        headers: {
          'content-type': 'application/json',
          origin: 'https://api.example.com',
        },
        method: 'POST',
      })
    );

    expect(response.status).toBe(502);
    const data = (await response.json()) as { success: boolean; supportCode?: string };
    expect(data.success).toBe(false);
    expect(data.supportCode).toMatch(/^VFY1-/);

    const loggedSupportCode = (
      warnMock.mock.calls as unknown as Array<[string, Record<string, unknown>?]>
    )
      .map((call) => call[1] as Record<string, unknown> | undefined)
      .find((meta) => meta?.supportCode)?.supportCode;
    expect(loggedSupportCode).toBe(data.supportCode);
  });
});
