import { describe, expect, it } from 'bun:test';
import { getSafeRelativeRedirectTarget, normalizeAuthRedirectTarget } from '../src/authRedirects';

describe('auth redirect targets', () => {
  it('rejects open redirects', () => {
    expect(getSafeRelativeRedirectTarget('//evil.example/steal')).toBeNull();
  });

  it('keeps dashboard auth independent from guild selection', () => {
    expect(normalizeAuthRedirectTarget('/dashboard?guild_id=123&tenant_id=abc')).toBe('/dashboard');
    expect(normalizeAuthRedirectTarget('/dashboard/integrations?guild_id=123')).toBe(
      '/dashboard/integrations'
    );
  });

  it('preserves dashboard guild context when bootstrap tokens live in the hash', () => {
    expect(normalizeAuthRedirectTarget('/dashboard?guild_id=123&tenant_id=abc#s=setup-token')).toBe(
      '/dashboard?guild_id=123&tenant_id=abc#s=setup-token'
    );
    expect(normalizeAuthRedirectTarget('/dashboard?guild_id=123#token=connect-token')).toBe(
      '/dashboard?guild_id=123#token=connect-token'
    );
  });

  it('strips dashboard guild context when the bootstrap hash token is empty', () => {
    expect(normalizeAuthRedirectTarget('/dashboard?guild_id=123&tenant_id=abc#s=')).toBe(
      '/dashboard#s='
    );
    expect(normalizeAuthRedirectTarget('/dashboard?guild_id=123#token=')).toBe('/dashboard#token=');
  });

  it('preserves explicit setup routes', () => {
    expect(normalizeAuthRedirectTarget('/connect?guild_id=123')).toBe('/connect?guild_id=123');
    expect(normalizeAuthRedirectTarget('/setup/vrchat?guild_id=123&mode=connect')).toBe(
      '/setup/vrchat?guild_id=123&mode=connect'
    );
  });

  it('falls back away from auth loop routes', () => {
    expect(normalizeAuthRedirectTarget('/sign-in')).toBe('/dashboard');
    expect(normalizeAuthRedirectTarget('/sign-in-redirect?redirectTo=%2Fdashboard')).toBe(
      '/dashboard'
    );
  });
});
