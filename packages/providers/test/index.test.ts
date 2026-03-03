// Placeholder test scaffold for providers package

import { describe, expect, it } from 'bun:test';
import { type ProviderAdapter, createProviderAdapter, detectLicenseFormat } from '../src/index';

describe('providers', () => {
  describe('createProviderAdapter', () => {
    it('should create a Gumroad adapter when clientId and clientSecret provided', () => {
      const adapter = createProviderAdapter('gumroad', {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      });
      expect(adapter).toBeDefined();
      expect(adapter.name).toBe('gumroad');
    });

    it('should throw for Gumroad without clientId and clientSecret', () => {
      expect(() => createProviderAdapter('gumroad', {})).toThrow(
        'Gumroad adapter requires clientId and clientSecret in config'
      );
    });

    it('should throw for Jinxxy without apiKey (use JinxxyAdapter directly with apiKey)', () => {
      expect(() => createProviderAdapter('jinxxy', {})).toThrow('Use JinxxyAdapter directly with apiKey config');
    });

    it('should create a Jinxxy adapter when apiKey provided', () => {
      const adapter = createProviderAdapter('jinxxy', { apiKey: 'test-api-key' });
      expect(adapter).toBeDefined();
      expect(adapter.name).toBe('jinxxy');
    });

    it('should create a Discord adapter', () => {
      const adapter = createProviderAdapter('discord', {});
      expect(adapter).toBeDefined();
      expect(adapter.name).toBe('discord');
    });

    it('should create a Manual adapter', () => {
      const adapter = createProviderAdapter('manual', {});
      expect(adapter).toBeDefined();
      expect(adapter.name).toBe('manual');
    });

    it('should throw for unknown provider type', () => {
      expect(() => createProviderAdapter('unknown' as never, {})).toThrow();
    });
  });

  describe('ProviderAdapter interface', () => {
    it('should have verifyPurchase method', async () => {
      const adapter: ProviderAdapter = createProviderAdapter('gumroad', {
        clientId: 'x',
        clientSecret: 'y',
      });
      expect(typeof adapter.verifyPurchase).toBe('function');
    });

    it('should have getRecentPurchases method', async () => {
      const adapter: ProviderAdapter = createProviderAdapter('gumroad', {
        clientId: 'x',
        clientSecret: 'y',
      });
      expect(typeof adapter.getRecentPurchases).toBe('function');
    });
  });

  describe('detectLicenseFormat', () => {
    it('should detect Gumroad format (8-8-8-8 alphanumeric)', () => {
      expect(detectLicenseFormat('ABCD1234-EFGH5678-IJKL9012-MNOP3456')).toBe('gumroad');
      expect(detectLicenseFormat('abcdef12-34567890-abcdef12-34567890')).toBe('gumroad');
    });

    it('should detect Jinxxy UUID format (8-4-4-4-12)', () => {
      expect(detectLicenseFormat('550e8400-e29b-41d4-a716-446655440000')).toBe('jinxxy');
    });

    it('should detect Jinxxy short_key format (4-12)', () => {
      expect(detectLicenseFormat('ABCD-1234567890ab')).toBe('jinxxy');
    });

    it('should return unknown for invalid formats', () => {
      expect(detectLicenseFormat('')).toBe('unknown');
      expect(detectLicenseFormat('invalid')).toBe('unknown');
      expect(detectLicenseFormat('123-456')).toBe('unknown');
    });
  });
});
