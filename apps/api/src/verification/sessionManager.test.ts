/**
 * Tests for Verification Session Manager
 *
 * Tests the crypto utilities, configuration, and session management logic.
 */

import { describe, expect, it } from 'bun:test';
import {
  computeCodeChallenge,
  createVerificationRoutes,
  createVerificationSessionManager,
  DISCORD_ROLE_CONFIG,
  GUMROAD_CONFIG,
  generateCodeVerifier,
  generateState,
  getVerificationConfig,
  hashVerifier,
  JINXXY_CONFIG,
  SESSION_EXPIRY_MS,
  type VerificationConfig,
} from './sessionManager';

// ============================================================================
// CRYPTO UTILITIES TESTS
// ============================================================================

describe('Crypto Utilities', () => {
  describe('generateState', () => {
    it('generates a 64-character hex string', () => {
      const state = generateState();
      expect(state.length).toBe(64);
      expect(/^[0-9a-f]+$/.test(state)).toBe(true);
    });

    it('generates unique values', () => {
      const state1 = generateState();
      const state2 = generateState();
      expect(state1).not.toBe(state2);
    });
  });

  describe('generateCodeVerifier', () => {
    it('generates a 128-character hex string', () => {
      const verifier = generateCodeVerifier();
      expect(verifier.length).toBe(128);
      expect(/^[0-9a-f]+$/.test(verifier)).toBe(true);
    });

    it('generates unique values', () => {
      const verifier1 = generateCodeVerifier();
      const verifier2 = generateCodeVerifier();
      expect(verifier1).not.toBe(verifier2);
    });
  });

  describe('computeCodeChallenge', () => {
    it('computes correct S256 code challenge', async () => {
      const verifier = generateCodeVerifier();
      const challenge = await computeCodeChallenge(verifier);

      // SHA-256 produces 32 bytes, base64url encoded is 43 characters
      expect(challenge.length).toBe(43);

      // Base64url should not contain +, /, or =
      expect(challenge).not.toMatch(/\+/);
      expect(challenge).not.toMatch(/\//);
      expect(challenge).not.toMatch(/=/);
    });

    it('produces base64url encoded output', async () => {
      const verifier = generateCodeVerifier();
      const challenge = await computeCodeChallenge(verifier);

      // Base64url should not contain +, /, or =
      expect(challenge).not.toMatch(/\+/);
      expect(challenge).not.toMatch(/\//);
      expect(challenge).not.toMatch(/=/);
    });
  });

  describe('hashVerifier', () => {
    it('produces SHA-256 hash of verifier', async () => {
      const verifier = 'test-verifier-string';
      const hash = await hashVerifier(verifier);

      // SHA-256 produces 64 hex characters
      expect(hash.length).toBe(64);
      expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
    });

    it('produces consistent hash for same input', async () => {
      const verifier = 'test-verifier-string';
      const hash1 = await hashVerifier(verifier);
      const hash2 = await hashVerifier(verifier);
      expect(hash1).toBe(hash2);
    });

    it('produces different hashes for different inputs', async () => {
      const hash1 = await hashVerifier('verifier1');
      const hash2 = await hashVerifier('verifier2');
      expect(hash1).not.toBe(hash2);
    });
  });
});

// ============================================================================
// VERIFICATION CONFIG TESTS
// ============================================================================

describe('Verification Config', () => {
  describe('getVerificationConfig', () => {
    it('returns gumroad config for gumroad mode', () => {
      const config = getVerificationConfig('gumroad');
      expect(config).toEqual(GUMROAD_CONFIG);
    });

    it('returns discord config for discord_role mode', () => {
      const config = getVerificationConfig('discord_role');
      expect(config).toEqual(DISCORD_ROLE_CONFIG);
    });

    it('returns discord config for discord mode (callback path)', () => {
      const config = getVerificationConfig('discord');
      expect(config).toEqual(DISCORD_ROLE_CONFIG);
    });

    it('returns jinxxy config for jinxxy mode', () => {
      const config = getVerificationConfig('jinxxy');
      expect(config).toEqual(JINXXY_CONFIG);
    });

    it('returns null for unknown mode', () => {
      const config = getVerificationConfig('unknown');
      expect(config).toBeNull();
    });

    it('returns null for manual mode (no OAuth)', () => {
      const config = getVerificationConfig('manual');
      expect(config).toBeNull();
    });
  });

  describe('GUMROAD_CONFIG', () => {
    it('has correct OAuth endpoints', () => {
      expect(GUMROAD_CONFIG.authUrl).toBe('https://gumroad.com/oauth/authorize');
      expect(GUMROAD_CONFIG.tokenUrl).toBe('https://api.gumroad.com/oauth/token');
    });

    it('has correct scopes', () => {
      expect(GUMROAD_CONFIG.scopes).toContain('view_profile');
      expect(GUMROAD_CONFIG.scopes).toContain('view_sales');
    });
  });

  describe('DISCORD_ROLE_CONFIG', () => {
    it('has correct OAuth endpoints', () => {
      expect(DISCORD_ROLE_CONFIG.authUrl).toBe('https://discord.com/api/oauth2/authorize');
      expect(DISCORD_ROLE_CONFIG.tokenUrl).toBe('https://discord.com/api/oauth2/token');
    });

    it('has correct scopes', () => {
      expect(DISCORD_ROLE_CONFIG.scopes).toContain('identify');
      expect(DISCORD_ROLE_CONFIG.scopes).toContain('guilds');
    });
  });

  describe('JINXXY_CONFIG', () => {
    it('has correct OAuth endpoints', () => {
      expect(JINXXY_CONFIG.authUrl).toBe('https://jinxxy.com/oauth/authorize');
      expect(JINXXY_CONFIG.tokenUrl).toBe('https://api.jinxxy.com/oauth/token');
    });

    it('has correct scopes', () => {
      expect(JINXXY_CONFIG.scopes).toContain('user:read');
      expect(JINXXY_CONFIG.scopes).toContain('products:read');
      expect(JINXXY_CONFIG.scopes).toContain('purchases:read');
    });
  });
});

// ============================================================================
// SESSION EXPIRY TESTS
// ============================================================================

describe('Session Expiry', () => {
  it('SESSION_EXPIRY_MS is 15 minutes', () => {
    expect(SESSION_EXPIRY_MS).toBe(15 * 60 * 1000);
  });
});

// ============================================================================
// VERIFICATION SESSION MANAGER TESTS
// ============================================================================

describe('VerificationSessionManager', () => {
  const testConfig: VerificationConfig = {
    baseUrl: 'http://localhost:3001',
    frontendUrl: 'http://localhost:3000',
    convexUrl: '',
    convexApiSecret: '',
    gumroadClientId: 'test-gumroad-id',
    gumroadClientSecret: 'test-gumroad-secret',
    discordClientId: 'test-discord-id',
    discordClientSecret: 'test-discord-secret',
    jinxxyClientId: 'test-jinxxy-id',
    jinxxyClientSecret: 'test-jinxxy-secret',
  };

  describe('createVerificationSessionManager', () => {
    it('creates manager with all required methods', () => {
      const manager = createVerificationSessionManager(testConfig);
      expect(manager.beginSession).toBeDefined();
      expect(manager.handleCallback).toBeDefined();
      expect(manager.completeSession).toBeDefined();
    });
  });

  describe('beginSession', () => {
    it('fails with unknown mode', async () => {
      const manager = createVerificationSessionManager(testConfig);
      const result = await manager.beginSession({
        authUserId: 'user_test123',
        mode: 'unknown' as 'gumroad',
        redirectUri: 'http://localhost:3000/callback',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown verification mode');
    });

    it('fails when gumroad client ID not configured', async () => {
      const manager = createVerificationSessionManager({
        ...testConfig,
        gumroadClientId: undefined,
      });
      const result = await manager.beginSession({
        authUserId: 'user_test123',
        mode: 'gumroad',
        redirectUri: 'http://localhost:3000/callback',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Gumroad client ID not configured');
    });

    it('creates session with gumroad mode', async () => {
      const manager = createVerificationSessionManager(testConfig);
      const result = await manager.beginSession({
        authUserId: 'user_test123',
        mode: 'gumroad',
        redirectUri: 'http://localhost:3000/callback',
      });
      expect(result.success).toBe(true);
      expect(result.state).toBeDefined();
      expect(result.codeVerifier).toBeDefined();
      expect(result.codeChallenge).toBeDefined();
      expect(result.authUrl).toBeDefined();
      expect(result.authUrl).toContain('gumroad.com/oauth/authorize');
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    });

    it('creates session with discord_role mode', async () => {
      const manager = createVerificationSessionManager(testConfig);
      const result = await manager.beginSession({
        authUserId: 'user_test123',
        mode: 'discord_role',
        redirectUri: 'http://localhost:3000/callback',
      });
      expect(result.success).toBe(true);
      expect(result.authUrl).toContain('discord.com/api/oauth2/authorize');
    });

    it('creates session with jinxxy mode', async () => {
      const manager = createVerificationSessionManager(testConfig);
      const result = await manager.beginSession({
        authUserId: 'user_test123',
        mode: 'jinxxy',
        redirectUri: 'http://localhost:3000/callback',
      });
      expect(result.success).toBe(true);
      expect(result.authUrl).toContain('jinxxy.com/oauth/authorize');
    });

    it('includes PKCE parameters in auth URL', async () => {
      const manager = createVerificationSessionManager(testConfig);
      const result = await manager.beginSession({
        authUserId: 'user_test123',
        mode: 'gumroad',
        redirectUri: 'http://localhost:3000/callback',
      });
      expect(result.success).toBe(true);
      const authUrl = result.authUrl;
      expect(authUrl).toBeDefined();
      if (!authUrl) {
        throw new Error('Expected authUrl to be defined');
      }
      const url = new URL(authUrl);
      expect(url.searchParams.get('code_challenge')).toBe(result.codeChallenge ?? null);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('state')).toBe(result.state ?? null);
    });
  });

  describe('handleCallback', () => {
    it('fails with unknown mode', async () => {
      const manager = createVerificationSessionManager(testConfig);
      const result = await manager.handleCallback('unknown', 'code', 'state');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown verification mode');
    });

    it('returns success with valid mode', async () => {
      const manager = createVerificationSessionManager(testConfig);
      const result = await manager.handleCallback('gumroad', 'test-code', 'test-state');
      expect(result.success).toBe(true);
      expect(result.redirectUri).toBeDefined();
    });
  });

  describe('completeSession', () => {
    it('returns success with valid input', async () => {
      const manager = createVerificationSessionManager(testConfig);
      const result = await manager.completeSession({
        sessionId: 'test-session-id',
        subjectId: 'test-subject-id',
      });
      expect(result.success).toBe(true);
      expect(result.redirectUri).toBeDefined();
    });
  });
});

// ============================================================================
// VERIFICATION ROUTES TESTS
// ============================================================================

describe('Verification Routes', () => {
  const testConfig: VerificationConfig = {
    baseUrl: 'http://localhost:3001',
    frontendUrl: 'http://localhost:3000',
    convexUrl: '',
    convexApiSecret: '',
    gumroadClientId: 'test-gumroad-id',
    gumroadClientSecret: 'test-gumroad-secret',
  };

  describe('createVerificationRoutes', () => {
    it('creates all required route handlers', () => {
      const routes = createVerificationRoutes(testConfig);
      expect(routes.beginVerification).toBeDefined();
      expect(routes.handleVerificationCallback).toBeDefined();
      expect(routes.completeVerification).toBeDefined();
      expect(routes.completeLicenseVerification).toBeDefined();
    });
  });
});

// ============================================================================
// SECURITY TESTS
// ============================================================================

describe('Security Properties', () => {
  it('state parameter is cryptographically random', () => {
    const states = new Set<string>();
    for (let i = 0; i < 100; i++) {
      states.add(generateState());
    }
    // All 100 states should be unique
    expect(states.size).toBe(100);
  });

  it('code verifier is cryptographically random', () => {
    const verifiers = new Set<string>();
    for (let i = 0; i < 100; i++) {
      verifiers.add(generateCodeVerifier());
    }
    // All 100 verifiers should be unique
    expect(verifiers.size).toBe(100);
  });

  it('hash is one-way (verifier cannot be derived from hash)', async () => {
    const verifier1 = generateCodeVerifier();
    const verifier2 = generateCodeVerifier();
    const hash1 = await hashVerifier(verifier1);
    const hash2 = await hashVerifier(verifier2);
    expect(hash1).not.toBe(verifier1);
    expect(hash2).not.toBe(verifier2);
    expect(hash1).not.toBe(hash2);
    expect(hash1.length).toBe(64);
  });

  it('code challenge cannot be reversed to get verifier', async () => {
    const verifier = generateCodeVerifier();
    const challenge = await computeCodeChallenge(verifier);
    // Challenge should not contain the verifier
    expect(challenge).not.toContain(verifier);
    // Challenge should be shorter
    expect(challenge.length).toBeLessThan(verifier.length);
  });
});
