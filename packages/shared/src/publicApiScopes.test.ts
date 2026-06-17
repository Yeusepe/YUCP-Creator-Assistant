import { describe, expect, it } from 'bun:test';
import { getOAuthScopeDisplay } from './publicApiScopes';

describe('getOAuthScopeDisplay', () => {
  it('resolves YUCP API scopes to their catalog copy', () => {
    const products = getOAuthScopeDisplay('products:read');
    expect(products.label).toBe('Read product catalog');
    expect(products.badge).not.toBe('Access');
  });

  it('resolves standard OIDC scopes (offline_access) with real copy, not the fallback', () => {
    const offline = getOAuthScopeDisplay('offline_access');
    expect(offline.label).toBe('Stay signed in');
    expect(offline.description).not.toBe('Custom permission scope');
    expect(offline.badge).not.toBe('Access');
  });

  it('falls back gracefully for unknown scopes', () => {
    expect(getOAuthScopeDisplay('totally:made-up')).toEqual({
      label: 'totally:made-up',
      description: 'Custom permission scope',
      badge: 'Access',
    });
  });
});
