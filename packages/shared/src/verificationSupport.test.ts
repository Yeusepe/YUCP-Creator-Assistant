import { afterEach, describe, expect, it } from 'bun:test';
import {
  decodeVerificationSupportToken,
  encodeVerificationSupportToken,
  sanitizeVerificationSupportErrorSummary,
} from './verificationSupport';

const originalErrorReferenceSecret = process.env.ERROR_REFERENCE_SECRET;
const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;

afterEach(() => {
  process.env.ERROR_REFERENCE_SECRET = originalErrorReferenceSecret;
  process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
});

describe('verificationSupport', () => {
  it('encodes and decodes verification support tokens', async () => {
    process.env.ERROR_REFERENCE_SECRET = 'test-support-secret';

    const encoded = await encodeVerificationSupportToken({
      surface: 'bot',
      stage: 'verify_panel_build',
      authUserId: 'user_test123',
      guildId: 'guild_123',
      discordUserId: 'user_123',
      provider: 'gumroad',
      hadActivePanel: true,
      errorName: 'TypeError',
      errorSummary: 'Failed to build verify panel',
    });

    expect(encoded.mode).toBe('encoded');
    expect(encoded.supportCode.startsWith('VFY1-')).toBe(true);

    const decoded = await decodeVerificationSupportToken(encoded.supportCode);
    expect(decoded.mode).toBe('encoded');
    expect(decoded.payload).toMatchObject({
      version: '1',
      surface: 'bot',
      stage: 'verify_panel_build',
      authUserId: 'user_test123',
      guildId: 'guild_123',
      discordUserId: 'user_123',
      provider: 'gumroad',
      hadActivePanel: true,
      errorName: 'TypeError',
      errorSummary: 'Failed to build verify panel',
    });
  });

  it('rejects tampered verification support tokens', async () => {
    process.env.ERROR_REFERENCE_SECRET = 'test-support-secret';

    const encoded = await encodeVerificationSupportToken({
      surface: 'api',
      stage: 'complete_license',
      errorSummary: 'Internal route error',
    });

    const tampered = `${encoded.supportCode.slice(0, -1)}A`;
    await expect(decodeVerificationSupportToken(tampered)).rejects.toThrow(
      'Verification support token could not be decrypted.'
    );
  });

  it('uses BETTER_AUTH_SECRET as a fallback secret', async () => {
    process.env.ERROR_REFERENCE_SECRET = undefined;
    process.env.BETTER_AUTH_SECRET = 'fallback-secret';

    const encoded = await encodeVerificationSupportToken({
      surface: 'api',
      stage: 'panel_refresh',
    });

    expect(encoded.mode).toBe('encoded');
    const decoded = await decodeVerificationSupportToken(encoded.supportCode);
    expect(decoded.payload?.stage).toBe('panel_refresh');
  });

  it('falls back to a plain support code when no secret exists', async () => {
    process.env.ERROR_REFERENCE_SECRET = '';
    process.env.BETTER_AUTH_SECRET = '';

    const encoded = await encodeVerificationSupportToken({
      surface: 'bot',
      stage: 'disconnect',
    });

    expect(encoded.mode).toBe('plain');
    expect(encoded.supportCode.startsWith('VFY0-')).toBe(true);

    const decoded = await decodeVerificationSupportToken(encoded.supportCode);
    expect(decoded).toEqual({
      mode: 'plain',
      supportCode: encoded.supportCode,
    });
  });

  it('sanitizes and truncates error summaries', () => {
    const summary = sanitizeVerificationSupportErrorSummary(
      new Error(`secret=abcd1234567890 ${'x'.repeat(300)}`)
    );

    expect(summary).toBeDefined();
    expect(summary?.includes('abcd1234567890')).toBe(false);
    expect(summary?.length).toBeLessThanOrEqual(160);
  });
});
