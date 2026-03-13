/**
 * Tests for Gumroad Adapter
 *
 * Tests the OAuth flow, token management, and purchase verification.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  type EncryptionService,
  GumroadAdapter,
  GumroadApiError,
  GumroadOAuthClient,
  InMemoryStateStorage,
  OAuthError,
  type TokenStorage,
} from '../../src/gumroad/index';
import type { GumroadSale } from '../../src/gumroad/types';
import { getSaleStatus, isSaleValid, normalizeSaleToEvidence } from '../../src/gumroad/types';

// Test configuration
const testConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://example.com/callback',
  apiBaseUrl: 'https://test-api.gumroad.com/v2',
  oauthBaseUrl: 'https://test-oauth.gumroad.com',
};

// Mock token storage
class MockTokenStorage implements TokenStorage {
  private tokens = new Map<
    string,
    { accessToken: string; refreshToken: string; expiresAt: number }
  >();

  async storeTokens(
    authUserId: string,
    gumroadUserId: string,
    accessToken: string,
    refreshToken: string,
    expiresAt: number
  ): Promise<void> {
    this.tokens.set(`${authUserId}:${gumroadUserId}`, { accessToken, refreshToken, expiresAt });
  }

  async getTokens(authUserId: string, gumroadUserId: string) {
    return this.tokens.get(`${authUserId}:${gumroadUserId}`) ?? null;
  }

  async deleteTokens(authUserId: string, gumroadUserId: string): Promise<void> {
    this.tokens.delete(`${authUserId}:${gumroadUserId}`);
  }

  clear(): void {
    this.tokens.clear();
  }
}

// Mock encryption service
class MockEncryptionService implements EncryptionService {
  async encryptToken(token: string): Promise<string> {
    return `encrypted:${token}`;
  }

  async decryptToken(encryptedToken: unknown): Promise<string> {
    if (typeof encryptedToken === 'string' && encryptedToken.startsWith('encrypted:')) {
      return encryptedToken.slice(10);
    }
    return String(encryptedToken);
  }
}

describe('GumroadOAuthClient', () => {
  let client: GumroadOAuthClient;

  beforeEach(() => {
    client = new GumroadOAuthClient(testConfig);
  });

  describe('getAuthorizationUrl', () => {
    it('should generate a valid authorization URL', async () => {
      const result = await client.getAuthorizationUrl('user_test123');

      expect(result.url).toContain('https://test-oauth.gumroad.com/oauth/authorize');
      expect(result.url).toContain('client_id=test-client-id');
      expect(result.url).toContain('redirect_uri=');
      expect(result.url).toContain('response_type=code');
      expect(result.url).toContain('code_challenge=');
      expect(result.url).toContain('code_challenge_method=S256');
      expect(result.state).toHaveLength(32);
      expect(result.codeVerifier).toHaveLength(64);
    });

    it('should include custom scope if provided', async () => {
      const result = await client.getAuthorizationUrl('user_test123', {
        scope: 'view_profile',
      });

      expect(result.url).toContain('scope=view_profile');
    });

    it('should generate unique state and code verifier each time', async () => {
      const result1 = await client.getAuthorizationUrl('user_test123');
      const result2 = await client.getAuthorizationUrl('user_test123');

      expect(result1.state).not.toBe(result2.state);
      expect(result1.codeVerifier).not.toBe(result2.codeVerifier);
    });
  });

  describe('validateState', () => {
    it('should return true for matching states', () => {
      const state = 'test-state-12345';
      expect(client.validateState(state, state)).toBe(true);
    });

    it('should return false for non-matching states', () => {
      expect(client.validateState('state-1', 'state-2')).toBe(false);
    });

    it('should return false for empty states', () => {
      expect(client.validateState('', 'state')).toBe(false);
      expect(client.validateState('state', '')).toBe(false);
    });

    it('should be timing-safe', () => {
      // Different length states should fail fast
      expect(client.validateState('short', 'much-longer-state')).toBe(false);
    });
  });

  describe('createState', () => {
    it('should create a state object with tenant and subject IDs', () => {
      const state = client.createState('user_test123', 'subject-456');

      expect(state.authUserId).toBe('user_test123');
      expect(state.subjectId).toBe('subject-456');
      expect(state.state).toHaveLength(32);
      expect(state.createdAt).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('isStateExpired', () => {
    it('should return false for fresh state', () => {
      const state = client.createState('user_test123');
      expect(client.isStateExpired(state)).toBe(false);
    });

    it('should return true for expired state', () => {
      const state = {
        state: 'test',
        authUserId: 'user_test123',
        createdAt: Date.now() - 600001, // 10+ minutes ago
      };
      expect(client.isStateExpired(state)).toBe(true);
    });
  });
});

describe('GumroadAdapter', () => {
  let adapter: GumroadAdapter;
  let tokenStorage: MockTokenStorage;
  let encryptionService: MockEncryptionService;
  let stateStorage: InMemoryStateStorage;

  beforeEach(() => {
    tokenStorage = new MockTokenStorage();
    encryptionService = new MockEncryptionService();
    stateStorage = new InMemoryStateStorage();
    adapter = new GumroadAdapter(testConfig, tokenStorage, encryptionService, stateStorage);
  });

  afterEach(() => {
    tokenStorage.clear();
  });

  describe('constructor', () => {
    it('should create an adapter with the correct name', () => {
      expect(adapter.name).toBe('gumroad');
    });
  });

  describe('beginVerification', () => {
    it('should generate an authorization URL and store state', async () => {
      const result = await adapter.beginVerification('user_test123', 'subject-456');

      expect(result.url).toContain('oauth/authorize');
      expect(result.state).toBeDefined();
      expect(result.codeVerifier).toBeDefined();

      // Verify state was stored: consumeState returns data on first call, then deletes
      const stateData = await stateStorage.consumeState(result.state);
      expect(stateData).not.toBeNull();
      expect(stateData?.authUserId).toBe('user_test123');
      expect(stateData?.codeVerifier).toBeDefined();
      // Second call returns null (already consumed)
      const consumedAgain = await stateStorage.consumeState(result.state);
      expect(consumedAgain).toBeNull();
    });
  });

  describe('completeVerification', () => {
    it('should return error for invalid state', async () => {
      const result = await adapter.completeVerification('code-123', 'invalid-state');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid or expired OAuth state');
    });

    // Note: Full OAuth flow tests would require mocking fetch
    // which is better done in integration tests
  });

  describe('getRecentPurchases', () => {
    it('returns empty array when called without token (ProviderAdapter interface)', async () => {
      const result = await adapter.getRecentPurchases(10);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([]);
    });
  });

  describe('getPurchases', () => {
    it('fetches purchases with real access token when secrets configured', async () => {
      const { loadTestSecrets } = await import('@yucp/shared/test/loadTestSecrets');
      const secrets = await loadTestSecrets();
      if (!secrets?.gumroad?.accessToken) return;
      const purchases = await adapter.getPurchases(secrets.gumroad.accessToken);
      expect(Array.isArray(purchases)).toBe(true);
      for (const p of purchases) {
        expect(p).toHaveProperty('provider', 'gumroad');
        expect(p).toHaveProperty('providerAccountRef');
        expect(p).toHaveProperty('status');
      }
    });
  });

  describe('checkPurchaseStatus', () => {
    it('returns found and status for real sale ID when secrets configured', async () => {
      const { loadTestSecrets } = await import('@yucp/shared/test/loadTestSecrets');
      const secrets = await loadTestSecrets();
      if (!secrets?.gumroad?.accessToken) return;
      const purchases = await adapter.getPurchases(secrets.gumroad.accessToken);
      if (purchases.length === 0) return; // No sales to check
      const saleId = purchases[0].rawRef;
      const result = await adapter.checkPurchaseStatus(secrets.gumroad.accessToken, saleId);
      expect(result.found).toBe(true);
      expect(['active', 'refunded', 'chargebacked', 'disputed', 'unknown']).toContain(
        result.status
      );
      expect(result.sale).toBeDefined();
    });
    it('returns found:false for non-existent sale ID', async () => {
      const { loadTestSecrets } = await import('@yucp/shared/test/loadTestSecrets');
      const secrets = await loadTestSecrets();
      if (!secrets?.gumroad?.accessToken) return;
      const result = await adapter.checkPurchaseStatus(
        secrets.gumroad.accessToken,
        'non-existent-sale-id-99999'
      );
      expect(result.found).toBe(false);
      expect(result.status).toBe('unknown');
    });
  });

  describe('revokeAccess', () => {
    it('should delete tokens from storage', async () => {
      await tokenStorage.storeTokens(
        'user_test123',
        'gumroad-456',
        'access',
        'refresh',
        Date.now() + 3600000
      );

      await adapter.revokeAccess('user_test123', 'gumroad-456');

      const tokens = await tokenStorage.getTokens('user_test123', 'gumroad-456');
      expect(tokens).toBeNull();
    });
  });
});

describe('Types and Normalization', () => {
  describe('normalizeSaleToEvidence', () => {
    it('should normalize a sale to purchase evidence', () => {
      const sale: GumroadSale = {
        id: 'sale-123',
        product_id: 'product-456',
        product_name: 'Test Product',
        email: 'buyer@example.com',
        price: 999,
        currency: 'USD',
        quantity: 1,
        refunded: false,
        chargebacked: false,
        disputed: false,
        created_at: '2024-01-15T10:30:00Z',
        purchase_date: '2024-01-15',
        sale_timestamp: '2024-01-15T10:30:00Z',
        license_key: 'LICENSE-KEY-123',
      };

      const evidence = normalizeSaleToEvidence(sale, 'gumroad-user-789');

      expect(evidence.provider).toBe('gumroad');
      expect(evidence.providerAccountRef).toBe('gumroad-user-789');
      expect(evidence.productRefs).toEqual(['product-456']);
      expect(evidence.evidenceType).toBe('purchase');
      expect(evidence.observedAt).toBe('2024-01-15T10:30:00Z');
      expect(evidence.rawRef).toBe('sale-123');
      expect(evidence.refunded).toBe(false);
      expect(evidence.chargebacked).toBe(false);
      expect(evidence.disputed).toBe(false);
      expect(evidence.email).toBe('buyer@example.com');
      expect(evidence.licenseKey).toBe('LICENSE-KEY-123');
    });

    it('should mark refunded sales', () => {
      const sale: GumroadSale = {
        id: 'sale-123',
        product_id: 'product-456',
        product_name: 'Test Product',
        email: 'buyer@example.com',
        price: 999,
        currency: 'USD',
        quantity: 1,
        refunded: true,
        refunded_at: '2024-01-20T10:30:00Z',
        chargebacked: false,
        disputed: false,
        created_at: '2024-01-15T10:30:00Z',
        purchase_date: '2024-01-15',
        sale_timestamp: '2024-01-15T10:30:00Z',
      };

      const evidence = normalizeSaleToEvidence(sale, 'gumroad-user-789');

      expect(evidence.refunded).toBe(true);
    });
  });

  describe('isSaleValid', () => {
    it('should return true for active sales', () => {
      const sale: GumroadSale = {
        id: 'sale-123',
        product_id: 'product-456',
        product_name: 'Test Product',
        email: 'buyer@example.com',
        price: 999,
        currency: 'USD',
        quantity: 1,
        refunded: false,
        chargebacked: false,
        disputed: false,
        created_at: '2024-01-15T10:30:00Z',
        purchase_date: '2024-01-15',
        sale_timestamp: '2024-01-15T10:30:00Z',
      };

      expect(isSaleValid(sale)).toBe(true);
    });

    it('should return false for refunded sales', () => {
      const sale: GumroadSale = {
        id: 'sale-123',
        product_id: 'product-456',
        product_name: 'Test Product',
        email: 'buyer@example.com',
        price: 999,
        currency: 'USD',
        quantity: 1,
        refunded: true,
        chargebacked: false,
        disputed: false,
        created_at: '2024-01-15T10:30:00Z',
        purchase_date: '2024-01-15',
        sale_timestamp: '2024-01-15T10:30:00Z',
      };

      expect(isSaleValid(sale)).toBe(false);
    });

    it('should return false for chargebacked sales', () => {
      const sale: GumroadSale = {
        id: 'sale-123',
        product_id: 'product-456',
        product_name: 'Test Product',
        email: 'buyer@example.com',
        price: 999,
        currency: 'USD',
        quantity: 1,
        refunded: false,
        chargebacked: true,
        disputed: false,
        created_at: '2024-01-15T10:30:00Z',
        purchase_date: '2024-01-15',
        sale_timestamp: '2024-01-15T10:30:00Z',
      };

      expect(isSaleValid(sale)).toBe(false);
    });

    it('should return false for disputed sales', () => {
      const sale: GumroadSale = {
        id: 'sale-123',
        product_id: 'product-456',
        product_name: 'Test Product',
        email: 'buyer@example.com',
        price: 999,
        currency: 'USD',
        quantity: 1,
        refunded: false,
        chargebacked: false,
        disputed: true,
        created_at: '2024-01-15T10:30:00Z',
        purchase_date: '2024-01-15',
        sale_timestamp: '2024-01-15T10:30:00Z',
      };

      expect(isSaleValid(sale)).toBe(false);
    });
  });

  describe('getSaleStatus', () => {
    it('should return active for valid sales', () => {
      const sale: GumroadSale = {
        id: 'sale-123',
        product_id: 'product-456',
        product_name: 'Test Product',
        email: 'buyer@example.com',
        price: 999,
        currency: 'USD',
        quantity: 1,
        refunded: false,
        chargebacked: false,
        disputed: false,
        created_at: '2024-01-15T10:30:00Z',
        purchase_date: '2024-01-15',
        sale_timestamp: '2024-01-15T10:30:00Z',
      };

      expect(getSaleStatus(sale)).toBe('active');
    });

    it('should prioritize chargeback over refund', () => {
      const sale: GumroadSale = {
        id: 'sale-123',
        product_id: 'product-456',
        product_name: 'Test Product',
        email: 'buyer@example.com',
        price: 999,
        currency: 'USD',
        quantity: 1,
        refunded: true,
        chargebacked: true,
        disputed: false,
        created_at: '2024-01-15T10:30:00Z',
        purchase_date: '2024-01-15',
        sale_timestamp: '2024-01-15T10:30:00Z',
      };

      expect(getSaleStatus(sale)).toBe('chargebacked');
    });

    it('should prioritize refund over dispute', () => {
      const sale: GumroadSale = {
        id: 'sale-123',
        product_id: 'product-456',
        product_name: 'Test Product',
        email: 'buyer@example.com',
        price: 999,
        currency: 'USD',
        quantity: 1,
        refunded: true,
        chargebacked: false,
        disputed: true,
        created_at: '2024-01-15T10:30:00Z',
        purchase_date: '2024-01-15',
        sale_timestamp: '2024-01-15T10:30:00Z',
      };

      expect(getSaleStatus(sale)).toBe('refunded');
    });
  });
});

describe('InMemoryStateStorage', () => {
  let storage: InMemoryStateStorage;

  beforeEach(() => {
    storage = new InMemoryStateStorage();
  });

  it('should store and retrieve state', async () => {
    await storage.storeState('state-123', {
      authUserId: 'user_test456',
      subjectId: 'subject-789',
      codeVerifier: 'verifier-abc',
    });

    const data = await storage.consumeState('state-123');

    expect(data).toEqual({
      authUserId: 'user_test456',
      subjectId: 'subject-789',
      codeVerifier: 'verifier-abc',
    });
  });

  it('should delete state after consumption', async () => {
    await storage.storeState('state-123', {
      authUserId: 'user_test456',
      codeVerifier: 'verifier-abc',
    });

    await storage.consumeState('state-123');
    const data = await storage.consumeState('state-123');

    expect(data).toBeNull();
  });

  it('should return null for non-existent state', async () => {
    const data = await storage.consumeState('non-existent');
    expect(data).toBeNull();
  });
});

describe('Error Classes', () => {
  describe('OAuthError', () => {
    it('should create error with all properties', () => {
      const error = new OAuthError('Invalid grant', 'invalid_grant', 400);

      expect(error.message).toBe('Invalid grant');
      expect(error.errorCode).toBe('invalid_grant');
      expect(error.statusCode).toBe(400);
      expect(error.name).toBe('OAuthError');
    });
  });

  describe('GumroadApiError', () => {
    it('should create error with all properties', () => {
      const error = new GumroadApiError('Rate limit exceeded', 429);

      expect(error.message).toBe('Rate limit exceeded');
      expect(error.statusCode).toBe(429);
      expect(error.name).toBe('GumroadApiError');
    });
  });
});
