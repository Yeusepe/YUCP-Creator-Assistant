import { describe, expect, it } from 'vitest';
import {
  buildBetterAuthEqualityWhere,
  buildBetterAuthIdLookupWhere,
  buildBetterAuthUserLookupWhere,
  buildBetterAuthUserProviderLookupWhere,
  buildOAuthConsentLookupWhere,
  getBetterAuthPage,
} from './betterAuthAdapter';

describe('getBetterAuthPage', () => {
  it('unwraps paginated Better Auth adapter results', () => {
    expect(
      getBetterAuthPage({
        page: [{ clientId: 'client-a' }, { clientId: 'client-b' }],
      })
    ).toEqual([{ clientId: 'client-a' }, { clientId: 'client-b' }]);
  });

  it('returns an empty array when the adapter result is missing', () => {
    expect(getBetterAuthPage(null)).toEqual([]);
    expect(getBetterAuthPage(undefined)).toEqual([]);
  });
});

describe('buildOAuthConsentLookupWhere', () => {
  it('looks up oauth consents by consent id, not client id', () => {
    expect(buildOAuthConsentLookupWhere('user_123', 'consent_456')).toEqual([
      { field: 'userId', operator: 'eq', value: 'user_123' },
      { field: '_id', operator: 'eq', value: 'consent_456', connector: 'AND' },
    ]);
  });
});

describe('buildBetterAuthEqualityWhere', () => {
  it('adds explicit eq operators and AND connectors for multi-field lookups', () => {
    expect(
      buildBetterAuthEqualityWhere([
        { field: 'userId', value: 'user_123' },
        { field: 'providerId', value: 'discord' },
      ])
    ).toEqual([
      { field: 'userId', operator: 'eq', value: 'user_123' },
      { field: 'providerId', operator: 'eq', value: 'discord', connector: 'AND' },
    ]);
  });

  it('preserves single-field lookups without adding a connector', () => {
    expect(buildBetterAuthEqualityWhere([{ field: 'id', value: 'user_123' }])).toEqual([
      { field: 'id', operator: 'eq', value: 'user_123' },
    ]);
  });
});

describe('lookup helpers', () => {
  it('builds a stable user lookup filter', () => {
    expect(buildBetterAuthUserLookupWhere('user_123')).toEqual([
      { field: 'id', operator: 'eq', value: 'user_123' },
    ]);
  });

  it('builds a stable user-provider lookup filter', () => {
    expect(buildBetterAuthUserProviderLookupWhere('user_123', 'discord')).toEqual([
      { field: 'userId', operator: 'eq', value: 'user_123' },
      { field: 'providerId', operator: 'eq', value: 'discord', connector: 'AND' },
    ]);
  });

  it('builds a stable record-id lookup filter', () => {
    expect(buildBetterAuthIdLookupWhere('oauth_client_123')).toEqual([
      { field: '_id', operator: 'eq', value: 'oauth_client_123' },
    ]);
  });
});
