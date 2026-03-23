import { describe, expect, it } from 'bun:test';
import { handleYucpOAuthAuthorize } from './yucpOAuthProxy';

describe('handleYucpOAuthAuthorize', () => {
  it('stores loopback redirect sessions and redirects Better Auth to the fixed Convex callback', async () => {
    const storedSessions: Array<{ oauthState: string; originalRedirectUri: string }> = [];
    const response = await handleYucpOAuthAuthorize(
      new Request(
        'https://api.example.com/api/yucp/oauth/authorize' +
          '?client_id=yucp-unity-editor' +
          '&response_type=code' +
          '&code_challenge=test-challenge' +
          '&code_challenge_method=S256' +
          '&redirect_uri=http%3A%2F%2F127.0.0.1%3A57000%2Fcallback' +
          '&scope=verification%3Aread' +
          '&state=abcdefghijklmnopqrstuvwxyzABCDEF'
      ),
      {
        convexSiteUrl: 'https://convex.example.com',
        storeSession: async (session) => {
          storedSessions.push(session);
        },
      }
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://convex.example.com/api/auth/oauth2/authorize?client_id=yucp-unity-editor&response_type=code&code_challenge=test-challenge&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fconvex.example.com%2Fapi%2Fyucp%2Foauth%2Fcallback&scope=verification%3Aread&state=abcdefghijklmnopqrstuvwxyzABCDEF'
    );
    expect(storedSessions).toEqual([
      {
        oauthState: 'abcdefghijklmnopqrstuvwxyzABCDEF',
        originalRedirectUri: 'http://127.0.0.1:57000/callback',
      },
    ]);
  });

  it('passes through non-loopback redirect URIs without storing a loopback session', async () => {
    let storeCallCount = 0;
    const response = await handleYucpOAuthAuthorize(
      new Request(
        'https://api.example.com/api/yucp/oauth/authorize' +
          '?client_id=web-app' +
          '&response_type=code' +
          '&redirect_uri=https%3A%2F%2Fapp.example.com%2Foauth%2Fcallback' +
          '&scope=verification%3Aread' +
          '&state=abcdefghijklmnopqrstuvwxyzABCDEF'
      ),
      {
        convexSiteUrl: 'https://convex.example.com',
        storeSession: async () => {
          storeCallCount += 1;
        },
      }
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://convex.example.com/api/auth/oauth2/authorize?client_id=web-app&response_type=code&redirect_uri=https%3A%2F%2Fapp.example.com%2Foauth%2Fcallback&scope=verification%3Aread&state=abcdefghijklmnopqrstuvwxyzABCDEF'
    );
    expect(storeCallCount).toBe(0);
  });
});
