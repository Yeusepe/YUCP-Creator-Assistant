import { describe, expect, it } from 'vitest';
import { getErrorMessage, getServerIconUrl, isSafeReturnUrl } from '@/lib/utils';

describe('getServerIconUrl', () => {
  it('returns null when iconHash is null', () => {
    expect(getServerIconUrl('123', null)).toBeNull();
  });

  it('returns null when iconHash is undefined', () => {
    expect(getServerIconUrl('123', undefined)).toBeNull();
  });

  it('returns png URL for static icons', () => {
    const url = getServerIconUrl('123', 'abc123');
    expect(url).toBe('https://cdn.discordapp.com/icons/123/abc123.png?size=64');
  });

  it('returns gif URL for animated icons', () => {
    const url = getServerIconUrl('123', 'a_abc123');
    expect(url).toBe('https://cdn.discordapp.com/icons/123/a_abc123.gif?size=64');
  });
});

describe('isSafeReturnUrl', () => {
  it('allows same-origin URLs', () => {
    expect(isSafeReturnUrl('/dashboard')).toBe(true);
    expect(isSafeReturnUrl('/dashboard?guild_id=123')).toBe(true);
  });

  it('allows discord.com URLs', () => {
    expect(isSafeReturnUrl('https://discord.com/channels/123')).toBe(true);
  });

  it('allows discord:// protocol', () => {
    expect(isSafeReturnUrl('discord://test')).toBe(true);
  });

  it('rejects external URLs', () => {
    expect(isSafeReturnUrl('https://evil.com/steal')).toBe(false);
  });

  it('handles malformed URLs gracefully', () => {
    expect(isSafeReturnUrl('')).toBe(true); // empty resolves to same-origin
  });
});

describe('getErrorMessage', () => {
  it('maps known error codes to messages', () => {
    expect(getErrorMessage('link_expired')).toBe('This link has expired or was already used.');
    expect(getErrorMessage('invalid_token')).toBe('The verification token is invalid.');
    expect(getErrorMessage('session_expired')).toBe('Your session has expired. Please try again.');
    expect(getErrorMessage('rate_limited')).toBe(
      'Too many requests. Please wait a moment and try again.'
    );
  });

  it('converts unknown error codes to readable text', () => {
    expect(getErrorMessage('some_unknown_error')).toBe('some unknown error');
  });
});
