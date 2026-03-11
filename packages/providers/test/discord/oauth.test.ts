/**
 * Tests for Discord OAuth provider.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createAAD, decrypt, encrypt } from '@yucp/shared';
import { DiscordOAuthProvider } from '../../src/discord/oauth';
import type {
  DiscordOAuthConfig,
  DiscordOAuthTokens,
  DiscordUser,
  EncryptedDiscordTokens,
  OAuthState,
  TokenStorage,
} from '../../src/discord/types';

// Mock token storage implementation
class MockTokenStorage implements TokenStorage {
  private states = new Map<string, OAuthState>();
  private tokens = new Map<string, EncryptedDiscordTokens>();

  async storeState(state: OAuthState): Promise<void> {
    this.states.set(state.state, state);
  }

  async getState(state: string): Promise<OAuthState | null> {
    return this.states.get(state) ?? null;
  }

  async deleteState(state: string): Promise<void> {
    this.states.delete(state);
  }

  async storeTokens(verificationSessionId: string, tokens: EncryptedDiscordTokens): Promise<void> {
    this.tokens.set(verificationSessionId, tokens);
  }

  async getTokens(verificationSessionId: string): Promise<EncryptedDiscordTokens | null> {
    return this.tokens.get(verificationSessionId) ?? null;
  }

  async deleteTokens(verificationSessionId: string): Promise<void> {
    this.tokens.delete(verificationSessionId);
  }

  // Test helpers
  clear(): void {
    this.states.clear();
    this.tokens.clear();
  }

  getStoredStateCount(): number {
    return this.states.size;
  }
}

describe('DiscordOAuthProvider', () => {
  let provider: DiscordOAuthProvider;
  let storage: MockTokenStorage;
  let kekBytes: Uint8Array;
  let config: DiscordOAuthConfig;

  // Store original fetch
  let originalFetch: typeof fetch;

  beforeEach(() => {
    // Generate test KEK
    kekBytes = crypto.getRandomValues(new Uint8Array(32));

    config = {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'https://example.com/auth/discord/callback',
      scopes: ['identify', 'guilds.members.read'],
      kekBytes,
      keyId: 'test-kek-v1',
      keyVersion: 1,
      tenantId: 'test-tenant-123',
    };

    storage = new MockTokenStorage();
    provider = new DiscordOAuthProvider(config, storage);

    // Store original fetch
    originalFetch = global.fetch;
  });

  afterEach(() => {
    storage.clear();
    // Restore original fetch
    global.fetch = originalFetch;
  });

  describe('beginVerification', () => {
    it('should generate authorization URL with correct parameters', async () => {
      const result = await provider.beginVerification();

      expect(result).toBeDefined();
      expect(result.authorizationUrl).toBeDefined();
      expect(result.state).toBeDefined();
      expect(result.verificationSessionId).toBeDefined();

      // Parse authorization URL
      const url = new URL(result.authorizationUrl);
      expect(url.origin).toBe('https://discord.com');
      expect(url.pathname).toBe('/oauth2/authorize');

      // Check query parameters
      expect(url.searchParams.get('client_id')).toBe(config.clientId);
      expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('scope')).toBe('identify guilds.members.read');
      expect(url.searchParams.get('state')).toBe(result.state);
      expect(url.searchParams.get('code_challenge')).toBeDefined();
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    });

    it('should store OAuth state in storage', async () => {
      await provider.beginVerification();

      // State should be stored (we can't directly check, but we can verify getState works)
      // State exists in storage
      expect(storage.getStoredStateCount()).toBe(1);
    });

    it('should generate unique state and verification session IDs', async () => {
      const result1 = await provider.beginVerification();
      const result2 = await provider.beginVerification();

      expect(result1.state).not.toBe(result2.state);
      expect(result1.verificationSessionId).not.toBe(result2.verificationSessionId);
    });

    it('should generate valid PKCE code challenge', async () => {
      const result = await provider.beginVerification();

      const url = new URL(result.authorizationUrl);
      const codeChallenge = url.searchParams.get('code_challenge');

      // Code challenge should be base64url encoded
      expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(codeChallenge?.length).toBeGreaterThan(0);
    });

    it('should use default scopes if not specified', async () => {
      const configNoScopes = { ...config, scopes: undefined };
      const providerNoScopes = new DiscordOAuthProvider(configNoScopes, storage);

      const result = await providerNoScopes.beginVerification();
      const url = new URL(result.authorizationUrl);

      expect(url.searchParams.get('scope')).toBe('identify');
    });
  });

  describe('completeVerification', () => {
    const mockTokens: DiscordOAuthTokens = {
      access_token: 'mock-access-token',
      refresh_token: 'mock-refresh-token',
      token_type: 'Bearer',
      expires_in: 604800, // 7 days
      scope: 'identify guilds.members.read',
    };

    const mockUser: DiscordUser = {
      id: '1234567890',
      username: 'testuser',
      global_name: 'Test User',
      avatar: 'abc123',
      discriminator: '0',
    };

    it('should complete verification flow successfully', async () => {
      // Begin verification first
      const beginResult = await provider.beginVerification();

      // Mock fetch responses
      global.fetch = mock(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        if (url.includes('/oauth2/token')) {
          return new Response(JSON.stringify(mockTokens), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/users/@me')) {
          return new Response(JSON.stringify(mockUser), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(null, { status: 404 });
      }) as unknown as typeof fetch;

      const result = await provider.completeVerification(
        'auth-code',
        beginResult.state,
        beginResult.verificationSessionId
      );

      expect(result).toBeDefined();
      expect(result.user).toEqual(mockUser);
      expect(result.verificationSessionId).toBe(beginResult.verificationSessionId);
      expect(result.encryptedTokens).toBeDefined();
      expect(result.encryptedTokens.encryptedAccessToken).toBeDefined();
      expect(result.encryptedTokens.encryptedRefreshToken).toBeDefined();
    });

    it('should fail with invalid state', async () => {
      await expect(
        provider.completeVerification('code', 'invalid-state', 'session-id')
      ).rejects.toThrow('Invalid or expired OAuth state');
    });

    it('should fail with expired state', async () => {
      // Create an expired state manually
      const expiredState: OAuthState = {
        state: 'expired-state',
        codeVerifier: 'verifier',
        codeChallenge: 'challenge',
        createdAt: new Date(Date.now() - 20 * 60 * 1000), // 20 minutes ago
        verificationSessionId: 'session-id',
        expiresAt: new Date(Date.now() - 10 * 60 * 1000), // Expired 10 minutes ago
      };
      await storage.storeState(expiredState);

      await expect(
        provider.completeVerification('code', 'expired-state', 'session-id')
      ).rejects.toThrow('OAuth state has expired');
    });

    it('should fail with mismatched verification session ID', async () => {
      const beginResult = await provider.beginVerification();

      await expect(
        provider.completeVerification('code', beginResult.state, 'different-session-id')
      ).rejects.toThrow('Verification session ID mismatch');
    });

    it('should handle Discord API error during token exchange', async () => {
      const beginResult = await provider.beginVerification();

      global.fetch = mock(async () => {
        return new Response(JSON.stringify({ code: 40001, message: 'Invalid grant' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      await expect(
        provider.completeVerification(
          'invalid-code',
          beginResult.state,
          beginResult.verificationSessionId
        )
      ).rejects.toThrow('Discord token exchange failed');
    });

    it('should clean up state after completion', async () => {
      const beginResult = await provider.beginVerification();

      global.fetch = mock(async () => {
        return new Response(JSON.stringify(mockTokens), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      // First call is token exchange, second is user info
      let callCount = 0;
      global.fetch = mock(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response(JSON.stringify(mockTokens), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(mockUser), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      await provider.completeVerification(
        'auth-code',
        beginResult.state,
        beginResult.verificationSessionId
      );

      // State should be deleted
      const state = await storage.getState(beginResult.state);
      expect(state).toBeNull();
    });
  });

  describe('getUserInfo', () => {
    const mockUser: DiscordUser = {
      id: '1234567890',
      username: 'testuser',
      global_name: 'Test User',
      avatar: 'abc123',
      discriminator: '0',
    };

    it('should get user info with access token', async () => {
      global.fetch = mock(async (input: string | URL | Request) => {
        return new Response(JSON.stringify(mockUser), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const user = await provider.getUserInfo('test-access-token');

      expect(user).toEqual(mockUser);
    });

    it('should get user info with verification session ID', async () => {
      // Store encrypted tokens
      const accessToken = 'session-access-token';
      const encryptedAccessToken = await encrypt(accessToken, {
        keyId: config.keyId,
        keyVersion: config.keyVersion,
        kekBytes: config.kekBytes,
        aad: createAAD(config.tenantId, 'discord', 'access'),
      });

      const encryptedTokens: EncryptedDiscordTokens = {
        encryptedAccessToken,
        encryptedRefreshToken: encryptedAccessToken, // Placeholder
        expiresAt: new Date(Date.now() + 604800000),
        scopes: ['identify'],
        verificationSessionId: 'test-session-id',
      };

      await storage.storeTokens('test-session-id', encryptedTokens);

      global.fetch = mock(async () => {
        return new Response(JSON.stringify(mockUser), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const user = await provider.getUserInfo('test-session-id');

      expect(user).toEqual(mockUser);
    });

    it('should handle API error', async () => {
      global.fetch = mock(async () => {
        return new Response(JSON.stringify({ code: 401, message: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      await expect(provider.getUserInfo('invalid-token')).rejects.toThrow(
        'Discord user info fetch failed'
      );
    });
  });

  describe('getGuildMember', () => {
    const mockMember = {
      user: { id: '1234567890' },
      nick: 'Test Nick',
      avatar: 'guild-avatar',
      roles: ['role-1', 'role-2'],
      joined_at: '2024-01-01T00:00:00.000Z',
      deaf: false,
      mute: false,
    };

    it('should get guild member info with access token', async () => {
      global.fetch = mock(async () => {
        return new Response(JSON.stringify(mockMember), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const member = await provider.getGuildMember('test-access-token', 'guild-123');

      expect(member.userId).toBe('1234567890');
      expect(member.guildId).toBe('guild-123');
      expect(member.nick).toBe('Test Nick');
      expect(member.roles).toEqual(['role-1', 'role-2']);
    });

    it('should handle 403 Forbidden (user not in guild)', async () => {
      global.fetch = mock(async () => {
        return new Response(JSON.stringify({ code: 50001, message: 'Missing Access' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      await expect(provider.getGuildMember('token', 'guild-123')).rejects.toThrow('Access denied');
    });

    it('should handle 404 Not Found', async () => {
      global.fetch = mock(async () => {
        return new Response(JSON.stringify({ code: 10004, message: 'Unknown Guild' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      await expect(provider.getGuildMember('token', 'unknown-guild')).rejects.toThrow(
        'Guild not found'
      );
    });

    it('should fail if guilds.members.read scope not granted', async () => {
      // Store tokens without guilds.members.read scope
      const accessToken = 'test-access-token';
      const encryptedAccessToken = await encrypt(accessToken, {
        keyId: config.keyId,
        keyVersion: config.keyVersion,
        kekBytes: config.kekBytes,
        aad: createAAD(config.tenantId, 'discord', 'access'),
      });

      const encryptedTokens: EncryptedDiscordTokens = {
        encryptedAccessToken,
        encryptedRefreshToken: encryptedAccessToken,
        expiresAt: new Date(Date.now() + 604800000),
        scopes: ['identify'], // Missing guilds.members.read
        verificationSessionId: 'test-session-id',
      };

      await storage.storeTokens('test-session-id', encryptedTokens);

      await expect(provider.getGuildMember('test-session-id', 'guild-123')).rejects.toThrow(
        'guilds.members.read scope not granted'
      );
    });
  });

  describe('role checking methods', () => {
    const mockMember = {
      user: { id: '1234567890' },
      nick: null,
      avatar: null,
      roles: ['role-1', 'role-2', 'role-3'],
      joined_at: '2024-01-01T00:00:00.000Z',
      deaf: false,
      mute: false,
    };

    beforeEach(async () => {
      // Store tokens with guilds.members.read scope
      const accessToken = 'test-access-token';
      const encryptedAccessToken = await encrypt(accessToken, {
        keyId: config.keyId,
        keyVersion: config.keyVersion,
        kekBytes: config.kekBytes,
        aad: createAAD(config.tenantId, 'discord', 'access'),
      });

      const encryptedTokens: EncryptedDiscordTokens = {
        encryptedAccessToken,
        encryptedRefreshToken: encryptedAccessToken,
        expiresAt: new Date(Date.now() + 604800000),
        scopes: ['identify', 'guilds.members.read'],
        verificationSessionId: 'test-session-id',
      };

      await storage.storeTokens('test-session-id', encryptedTokens);
    });

    it('should check if user has specific role', async () => {
      global.fetch = mock(async () => {
        return new Response(JSON.stringify(mockMember), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const hasRole = await provider.hasRole('test-session-id', 'guild-123', 'role-1');
      expect(hasRole).toBe(true);

      const hasOtherRole = await provider.hasRole('test-session-id', 'guild-123', 'role-999');
      expect(hasOtherRole).toBe(false);
    });

    it('should check if user has any of specified roles', async () => {
      global.fetch = mock(async () => {
        return new Response(JSON.stringify(mockMember), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const hasAny = await provider.hasAnyRole('test-session-id', 'guild-123', [
        'role-999',
        'role-2',
      ]);
      expect(hasAny).toBe(true);

      const hasNone = await provider.hasAnyRole('test-session-id', 'guild-123', [
        'role-999',
        'role-888',
      ]);
      expect(hasNone).toBe(false);
    });

    it('should check if user has all specified roles', async () => {
      global.fetch = mock(async () => {
        return new Response(JSON.stringify(mockMember), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const hasAll = await provider.hasAllRoles('test-session-id', 'guild-123', [
        'role-1',
        'role-2',
      ]);
      expect(hasAll).toBe(true);

      const missingOne = await provider.hasAllRoles('test-session-id', 'guild-123', [
        'role-1',
        'role-999',
      ]);
      expect(missingOne).toBe(false);
    });
  });

  describe('token management', () => {
    it('should check if token is expired', async () => {
      // Store expired tokens
      const accessToken = 'test-access-token';
      const encryptedAccessToken = await encrypt(accessToken, {
        keyId: config.keyId,
        keyVersion: config.keyVersion,
        kekBytes: config.kekBytes,
        aad: createAAD(config.tenantId, 'discord', 'access'),
      });

      const expiredTokens: EncryptedDiscordTokens = {
        encryptedAccessToken,
        encryptedRefreshToken: encryptedAccessToken,
        expiresAt: new Date(Date.now() - 1000), // Expired
        scopes: ['identify'],
        verificationSessionId: 'test-session-id',
      };

      await storage.storeTokens('test-session-id', expiredTokens);

      const isExpired = await provider.isTokenExpired('test-session-id');
      expect(isExpired).toBe(true);
    });

    it('should return true if tokens not found', async () => {
      const isExpired = await provider.isTokenExpired('non-existent-session');
      expect(isExpired).toBe(true);
    });

    it('should refresh tokens', async () => {
      // Store initial tokens
      const accessToken = 'old-access-token';
      const refreshToken = 'old-refresh-token';
      const encryptedAccessToken = await encrypt(accessToken, {
        keyId: config.keyId,
        keyVersion: config.keyVersion,
        kekBytes: config.kekBytes,
        aad: createAAD(config.tenantId, 'discord', 'access'),
      });
      const encryptedRefreshToken = await encrypt(refreshToken, {
        keyId: config.keyId,
        keyVersion: config.keyVersion,
        kekBytes: config.kekBytes,
        aad: createAAD(config.tenantId, 'discord', 'refresh'),
      });

      const initialTokens: EncryptedDiscordTokens = {
        encryptedAccessToken,
        encryptedRefreshToken,
        expiresAt: new Date(Date.now() + 1000),
        scopes: ['identify'],
        verificationSessionId: 'test-session-id',
      };

      await storage.storeTokens('test-session-id', initialTokens);

      // Mock refresh response
      const newTokens: DiscordOAuthTokens = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        token_type: 'Bearer',
        expires_in: 604800,
        scope: 'identify',
      };

      global.fetch = mock(async () => {
        return new Response(JSON.stringify(newTokens), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const refreshed = await provider.refreshTokens('test-session-id');

      expect(refreshed).toBeDefined();
      expect(refreshed.scopes).toEqual(['identify']);

      // Verify the new tokens can be decrypted
      const decryptedAccess = await decrypt({
        kekBytes: config.kekBytes,
        payload: refreshed.encryptedAccessToken,
        aad: createAAD(config.tenantId, 'discord', 'access'),
      });
      expect(decryptedAccess).toBe('new-access-token');
    });

    it('should revoke tokens', async () => {
      // Store tokens
      const accessToken = 'access-to-revoke';
      const encryptedAccessToken = await encrypt(accessToken, {
        keyId: config.keyId,
        keyVersion: config.keyVersion,
        kekBytes: config.kekBytes,
        aad: createAAD(config.tenantId, 'discord', 'access'),
      });

      const tokens: EncryptedDiscordTokens = {
        encryptedAccessToken,
        encryptedRefreshToken: encryptedAccessToken,
        expiresAt: new Date(Date.now() + 604800000),
        scopes: ['identify'],
        verificationSessionId: 'test-session-id',
      };

      await storage.storeTokens('test-session-id', tokens);

      // Mock revocation response
      global.fetch = mock(async () => {
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch;

      await provider.revokeTokens('test-session-id');

      // Tokens should be deleted
      const stored = await storage.getTokens('test-session-id');
      expect(stored).toBeNull();
    });
    it('should not throw when revoking non-existent tokens', async () => {
      // revokeTokens returns early when tokens don't exist; must not throw
      await expect(provider.revokeTokens('non-existent')).resolves.toBeUndefined();
      const stored = await storage.getTokens('non-existent');
      expect(stored).toBeNull();
    });
  });
});

describe('PKCE utilities', () => {
  it('should generate valid code challenge from verifier', async () => {
    // This is tested indirectly through beginVerification
    // but we can verify the properties
    const verifier = 'test-verifier-123456789012345678901234567890';
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
    const challenge = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    expect(challenge).toBeDefined();
    expect(challenge.length).toBeGreaterThan(0);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('Token encryption', () => {
  it('should encrypt and decrypt Discord tokens correctly', async () => {
    const kekBytes = crypto.getRandomValues(new Uint8Array(32));
    const config: DiscordOAuthConfig = {
      clientId: 'test',
      clientSecret: 'test',
      redirectUri: 'https://example.com/callback',
      kekBytes,
      keyId: 'test-key',
      keyVersion: 1,
      tenantId: 'tenant-123',
    };

    const accessToken = 'discord-access-token-abc123';

    // Encrypt
    const encrypted = await encrypt(accessToken, {
      keyId: config.keyId,
      keyVersion: config.keyVersion,
      kekBytes: config.kekBytes,
      aad: createAAD(config.tenantId, 'discord', 'access'),
    });

    expect(encrypted).toBeDefined();
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.aadMetadata.provider).toBe('discord');
    expect(encrypted.aadMetadata.tokenType).toBe('access');

    // Decrypt
    const decrypted = await decrypt({
      kekBytes: config.kekBytes,
      payload: encrypted,
      aad: createAAD(config.tenantId, 'discord', 'access'),
    });

    expect(decrypted).toBe(accessToken);
  });

  it('should fail to decrypt with wrong tenant AAD', async () => {
    const kekBytes = crypto.getRandomValues(new Uint8Array(32));
    const accessToken = 'discord-access-token';

    const encrypted = await encrypt(accessToken, {
      keyId: 'key-1',
      keyVersion: 1,
      kekBytes,
      aad: createAAD('tenant-a', 'discord', 'access'),
    });

    await expect(
      decrypt({
        kekBytes,
        payload: encrypted,
        aad: createAAD('tenant-b', 'discord', 'access'),
      })
    ).rejects.toThrow('AAD mismatch');
  });
});
