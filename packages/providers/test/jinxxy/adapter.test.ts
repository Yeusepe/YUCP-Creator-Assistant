/**
 * Tests for Jinxxy Adapter
 *
 * Tests the API client, license verification, purchase verification, and pagination.
 * Integration tests use real Jinxxy API when JINXXY_API_KEY is configured (Infisical or env).
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import {
  JinxxyAdapter,
  JinxxyApiClient,
  JinxxyApiError,
  JinxxyRateLimitError,
} from '../../src/jinxxy/index';
import type {
  JinxxyLicense,
  JinxxyOrder,
  JinxxyCustomer,
  JinxxyEvidence,
  JinxxyPagination,
} from '../../src/jinxxy/types';
import {
  normalizeLicenseToEvidence,
  normalizeOrderToEvidence,
  isLicenseValid,
  isOrderValid,
} from '../../src/jinxxy/types';

// Test configuration
const testConfig = {
  apiKey: 'test-api-key-12345',
  apiBaseUrl: 'https://test-api.jinxxy.com/v1',
  timeout: 5000,
  maxRetries: 2,
};

describe('JinxxyApiClient', () => {
  let client: JinxxyApiClient;

  beforeEach(() => {
    client = new JinxxyApiClient(testConfig);
  });

  describe('constructor', () => {
    it('should create client with config', () => {
      expect(client).toBeDefined();
    });

    it('should throw error when API key is missing in fromEnv', () => {
      const originalEnv = process.env.JINXXY_API_KEY;
      delete process.env.JINXXY_API_KEY;

      expect(() => JinxxyApiClient.fromEnv()).toThrow('JINXXY_API_KEY');

      process.env.JINXXY_API_KEY = originalEnv;
    });

    it('should create client from environment', () => {
      const originalEnv = process.env.JINXXY_API_KEY;
      process.env.JINXXY_API_KEY = 'env-api-key';

      const envClient = JinxxyApiClient.fromEnv();
      expect(envClient).toBeDefined();

      process.env.JINXXY_API_KEY = originalEnv;
    });
  });
});

describe('JinxxyAdapter', () => {
  let adapter: JinxxyAdapter;

  beforeEach(() => {
    adapter = new JinxxyAdapter(testConfig);
  });

  describe('constructor', () => {
    it('should create an adapter with the correct name', () => {
      expect(adapter.name).toBe('jinxxy');
    });

    it('should throw error when API key is missing', () => {
      expect(() => new JinxxyAdapter({ apiKey: '' })).toThrow('API key is required');
    });

    it('should throw error when API key is undefined', () => {
      expect(() => new JinxxyAdapter({} as any)).toThrow('API key is required');
    });
  });

  describe('fromEnv', () => {
    it('should throw error when environment variable is missing', () => {
      const originalEnv = process.env.JINXXY_API_KEY;
      delete process.env.JINXXY_API_KEY;

      expect(() => JinxxyAdapter.fromEnv()).toThrow('JINXXY_API_KEY');

      process.env.JINXXY_API_KEY = originalEnv;
    });
  });

  describe('verifyLicense', () => {
    it('verifies license with real API when secrets configured', async () => {
      const { loadTestSecrets } = await import('@yucp/shared/test/loadTestSecrets');
      const secrets = await loadTestSecrets();
      if (!secrets?.jinxxy?.apiKey) return;
      const testAdapter = new JinxxyAdapter({ ...testConfig, apiKey: secrets.jinxxy.apiKey });
      const testLicenseKey = (secrets.jinxxy as { testLicenseKey?: string }).testLicenseKey;
      if (!testLicenseKey) return;
      const result = await testAdapter.verifyLicense(testLicenseKey);
      expect(result).toBeDefined();
      expect(typeof result.valid).toBe('boolean');
      if (result.license) {
        expect(result.license).toHaveProperty('id');
        expect(result.license).toHaveProperty('key');
        expect(result.license).toHaveProperty('status');
      }
    });
  });

  describe('verifyPurchase', () => {
    it('verifies purchase by email with real API when secrets configured', async () => {
      const { loadTestSecrets } = await import('@yucp/shared/test/loadTestSecrets');
      const secrets = await loadTestSecrets();
      if (!secrets?.jinxxy?.apiKey) return;
      const testAdapter = new JinxxyAdapter({ ...testConfig, apiKey: secrets.jinxxy.apiKey });
      const testEmail = (secrets.jinxxy as { testEmail?: string }).testEmail;
      if (!testEmail) return;
      const result = await testAdapter.verifyPurchase(testEmail);
      expect(result === null || (result && result.provider === 'jinxxy')).toBe(true);
    });
  });

  describe('getRecentPurchases', () => {
    it('returns purchase records with real API when secrets configured', async () => {
      const { loadTestSecrets } = await import('@yucp/shared/test/loadTestSecrets');
      const secrets = await loadTestSecrets();
      if (!secrets?.jinxxy?.apiKey) return;
      const testAdapter = new JinxxyAdapter({ ...testConfig, apiKey: secrets.jinxxy.apiKey });
      const result = await testAdapter.getRecentPurchases(10);
      expect(Array.isArray(result)).toBe(true);
      for (const p of result) {
        expect(p).toHaveProperty('productId');
        expect(p).toHaveProperty('purchaseDate');
      }
    });
  });

  describe('getLicenses', () => {
    it('returns licenses with real API when secrets configured', async () => {
      const { loadTestSecrets } = await import('@yucp/shared/test/loadTestSecrets');
      const secrets = await loadTestSecrets();
      if (!secrets?.jinxxy?.apiKey) return;
      const testAdapter = new JinxxyAdapter({ ...testConfig, apiKey: secrets.jinxxy.apiKey });
      const { licenses } = await testAdapter.getLicenses({ page: 1, per_page: 5 });
      expect(Array.isArray(licenses)).toBe(true);
      for (const lic of licenses) {
        expect(lic).toHaveProperty('id');
        expect(lic).toHaveProperty('key');
        expect(lic).toHaveProperty('status');
      }
    });
  });

  describe('getOrders', () => {
    it('returns orders with real API when secrets configured', async () => {
      const { loadTestSecrets } = await import('@yucp/shared/test/loadTestSecrets');
      const secrets = await loadTestSecrets();
      if (!secrets?.jinxxy?.apiKey) return;
      const testAdapter = new JinxxyAdapter({ ...testConfig, apiKey: secrets.jinxxy.apiKey });
      const { orders } = await testAdapter.getOrders({ page: 1, per_page: 5 });
      expect(Array.isArray(orders)).toBe(true);
      for (const ord of orders) {
        expect(ord).toHaveProperty('id');
        expect(ord).toHaveProperty('status');
        expect(ord).toHaveProperty('product_id');
      }
    });
  });

  describe('getClient', () => {
    it('should return the API client', () => {
      const apiClient = adapter.getClient();
      expect(apiClient).toBeInstanceOf(JinxxyApiClient);
    });
  });
});

describe('Types and Normalization', () => {
  describe('normalizeLicenseToEvidence', () => {
    it('should normalize a license to evidence', () => {
      const license: JinxxyLicense = {
        id: 'license-123',
        key: 'LICENSE-KEY-123',
        product_id: 'product-456',
        customer_id: 'customer-789',
        status: 'active',
        created_at: '2024-01-15T10:30:00Z',
        activation_count: 1,
        max_activations: 5,
      };

      const customer: JinxxyCustomer = {
        id: 'customer-789',
        email: 'buyer@example.com',
        discord_id: 'discord-123',
        created_at: '2024-01-10T10:00:00Z',
      };

      const evidence = normalizeLicenseToEvidence(license, customer);

      expect(evidence.provider).toBe('jinxxy');
      expect(evidence.providerAccountRef).toBe('customer-789');
      expect(evidence.productRefs).toEqual(['product-456']);
      expect(evidence.evidenceType).toBe('license');
      expect(evidence.observedAt).toBe('2024-01-15T10:30:00Z');
      expect(evidence.rawRef).toBe('license-123');
      expect(evidence.refunded).toBe(false);
      expect(evidence.licenseKey).toBe('LICENSE-KEY-123');
      expect(evidence.email).toBe('buyer@example.com');
      expect(evidence.discordId).toBe('discord-123');
    });

    it('should handle license without customer', () => {
      const license: JinxxyLicense = {
        id: 'license-123',
        key: 'LICENSE-KEY-123',
        product_id: 'product-456',
        status: 'active',
        created_at: '2024-01-15T10:30:00Z',
        activation_count: 0,
        max_activations: 5,
      };

      const evidence = normalizeLicenseToEvidence(license);

      expect(evidence.providerAccountRef).toBe('unknown');
      expect(evidence.email).toBeUndefined();
      expect(evidence.discordId).toBeUndefined();
    });

    it('should mark revoked licenses as refunded', () => {
      const license: JinxxyLicense = {
        id: 'license-123',
        key: 'LICENSE-KEY-123',
        product_id: 'product-456',
        status: 'revoked',
        created_at: '2024-01-15T10:30:00Z',
        activation_count: 0,
        max_activations: 5,
      };

      const evidence = normalizeLicenseToEvidence(license);

      expect(evidence.refunded).toBe(true);
    });
  });

  describe('normalizeOrderToEvidence', () => {
    it('should normalize an order to evidence', () => {
      const order: JinxxyOrder = {
        id: 'order-123',
        customer_id: 'customer-789',
        product_id: 'product-456',
        status: 'completed',
        total: 999,
        currency: 'USD',
        created_at: '2024-01-15T10:30:00Z',
        email: 'buyer@example.com',
        discord_id: 'discord-123',
        license_id: 'license-456',
        quantity: 1,
      };

      const evidence = normalizeOrderToEvidence(order);

      expect(evidence.provider).toBe('jinxxy');
      expect(evidence.providerAccountRef).toBe('customer-789');
      expect(evidence.productRefs).toEqual(['product-456']);
      expect(evidence.evidenceType).toBe('purchase');
      expect(evidence.observedAt).toBe('2024-01-15T10:30:00Z');
      expect(evidence.rawRef).toBe('order-123');
      expect(evidence.refunded).toBe(false);
      expect(evidence.licenseKey).toBe('license-456');
      expect(evidence.email).toBe('buyer@example.com');
      expect(evidence.discordId).toBe('discord-123');
    });

    it('should mark refunded orders', () => {
      const order: JinxxyOrder = {
        id: 'order-123',
        product_id: 'product-456',
        status: 'refunded',
        total: 999,
        currency: 'USD',
        created_at: '2024-01-15T10:30:00Z',
        refunded_at: '2024-01-20T10:30:00Z',
        quantity: 1,
      };

      const evidence = normalizeOrderToEvidence(order);

      expect(evidence.refunded).toBe(true);
    });

    it('should use email as providerAccountRef when customer_id is missing', () => {
      const order: JinxxyOrder = {
        id: 'order-123',
        product_id: 'product-456',
        status: 'completed',
        total: 999,
        currency: 'USD',
        created_at: '2024-01-15T10:30:00Z',
        email: 'buyer@example.com',
        quantity: 1,
      };

      const evidence = normalizeOrderToEvidence(order);

      expect(evidence.providerAccountRef).toBe('buyer@example.com');
    });
  });

  describe('isLicenseValid', () => {
    it('should return true for active licenses', () => {
      const license: JinxxyLicense = {
        id: 'license-123',
        key: 'KEY',
        product_id: 'product-456',
        status: 'active',
        created_at: '2024-01-15T10:30:00Z',
        activation_count: 1,
        max_activations: 5,
      };

      expect(isLicenseValid(license)).toBe(true);
    });

    it('should return false for disabled licenses', () => {
      const license: JinxxyLicense = {
        id: 'license-123',
        key: 'KEY',
        product_id: 'product-456',
        status: 'disabled',
        created_at: '2024-01-15T10:30:00Z',
        activation_count: 1,
        max_activations: 5,
      };

      expect(isLicenseValid(license)).toBe(false);
    });

    it('should return false for expired licenses', () => {
      const license: JinxxyLicense = {
        id: 'license-123',
        key: 'KEY',
        product_id: 'product-456',
        status: 'active',
        created_at: '2024-01-15T10:30:00Z',
        expires_at: '2024-01-01T00:00:00Z', // Past date
        activation_count: 1,
        max_activations: 5,
      };

      expect(isLicenseValid(license)).toBe(false);
    });

    it('should return true for active licenses with future expiration', () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const license: JinxxyLicense = {
        id: 'license-123',
        key: 'KEY',
        product_id: 'product-456',
        status: 'active',
        created_at: '2024-01-15T10:30:00Z',
        expires_at: futureDate.toISOString(),
        activation_count: 1,
        max_activations: 5,
      };

      expect(isLicenseValid(license)).toBe(true);
    });
  });

  describe('isOrderValid', () => {
    it('should return true for completed orders', () => {
      const order: JinxxyOrder = {
        id: 'order-123',
        product_id: 'product-456',
        status: 'completed',
        total: 999,
        currency: 'USD',
        created_at: '2024-01-15T10:30:00Z',
        quantity: 1,
      };

      expect(isOrderValid(order)).toBe(true);
    });

    it('should return false for refunded orders', () => {
      const order: JinxxyOrder = {
        id: 'order-123',
        product_id: 'product-456',
        status: 'refunded',
        total: 999,
        currency: 'USD',
        created_at: '2024-01-15T10:30:00Z',
        quantity: 1,
      };

      expect(isOrderValid(order)).toBe(false);
    });

    it('should return false for disputed orders', () => {
      const order: JinxxyOrder = {
        id: 'order-123',
        product_id: 'product-456',
        status: 'disputed',
        total: 999,
        currency: 'USD',
        created_at: '2024-01-15T10:30:00Z',
        quantity: 1,
      };

      expect(isOrderValid(order)).toBe(false);
    });

    it('should return false for pending orders', () => {
      const order: JinxxyOrder = {
        id: 'order-123',
        product_id: 'product-456',
        status: 'pending',
        total: 999,
        currency: 'USD',
        created_at: '2024-01-15T10:30:00Z',
        quantity: 1,
      };

      expect(isOrderValid(order)).toBe(false);
    });
  });
});

describe('Error Classes', () => {
  describe('JinxxyApiError', () => {
    it('should create error with all properties', () => {
      const error = new JinxxyApiError('Not found', 404, 'not_found', { resource: 'license' });

      expect(error.message).toBe('Not found');
      expect(error.statusCode).toBe(404);
      expect(error.errorCode).toBe('not_found');
      expect(error.details).toEqual({ resource: 'license' });
      expect(error.name).toBe('JinxxyApiError');
    });

    it('should create error with minimal properties', () => {
      const error = new JinxxyApiError('Unknown error', 500);

      expect(error.message).toBe('Unknown error');
      expect(error.statusCode).toBe(500);
      expect(error.errorCode).toBeUndefined();
      expect(error.details).toBeUndefined();
    });
  });

  describe('JinxxyRateLimitError', () => {
    it('should create rate limit error with default message', () => {
      const error = new JinxxyRateLimitError();

      expect(error.message).toBe('Rate limit exceeded');
      expect(error.statusCode).toBe(429);
      expect(error.errorCode).toBe('rate_limit_exceeded');
      expect(error.name).toBe('JinxxyRateLimitError');
    });

    it('should create rate limit error with retry after', () => {
      const error = new JinxxyRateLimitError('Too many requests', 5000);

      expect(error.message).toBe('Too many requests');
      expect(error.retryAfter).toBe(5000);
    });
  });
});
