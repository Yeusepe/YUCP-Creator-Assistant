import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { sendEmailOtpEmail } from './accountSecurityEmail';

describe('sendEmailOtpEmail', () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.EMAIL_FROM;
  let fetchCalls: Request[];

  beforeEach(() => {
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.EMAIL_FROM = 'Creator Assistant <no-reply@example.com>';
    fetchCalls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push(input instanceof Request ? input : new Request(String(input), init));
      return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalApiKey;
    if (originalFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = originalFrom;
  });

  it('refuses synthetic .invalid addresses before contacting Resend', async () => {
    await expect(
      sendEmailOtpEmail({
        email: '123456789012345678@discord.invalid',
        otp: '123456',
        type: 'sign-in',
      })
    ).rejects.toThrow('Cannot send email to a non-routable address');

    expect(fetchCalls).toHaveLength(0);
  });

  it('sends to routable addresses', async () => {
    await sendEmailOtpEmail({
      email: 'person@example.com',
      otp: '123456',
      type: 'sign-in',
    });

    expect(fetchCalls).toHaveLength(1);
    const body = (await fetchCalls[0]?.json()) as { to?: string[] };
    expect(body.to).toEqual(['person@example.com']);
  });
});
