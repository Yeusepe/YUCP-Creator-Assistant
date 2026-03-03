/**
 * Tests for Provider Registry
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Verification } from '@yucp/shared';
import type { ProviderAdapter, PurchaseRecord } from '../src/index';
import {
  type HealthCheckableAdapter,
  ProviderRegistry,
  type ProviderType,
  getGlobalRegistry,
  resetGlobalRegistry,
} from '../src/registry';

// Mock adapter for testing
class MockAdapter implements HealthCheckableAdapter {
  readonly name: string;
  private healthy = true;
  private shouldFailHealthCheck = false;

  constructor(name: string) {
    this.name = name;
  }

  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  setShouldFailHealthCheck(shouldFail: boolean): void {
    this.shouldFailHealthCheck = shouldFail;
  }

  async verifyPurchase(_emailOrId: string): Promise<Verification | null> {
    return this.healthy
      ? {
          id: 'test-id',
          userId: 'user-id',
          provider: this.name as Verification['provider'],
          status: 'verified',
          createdAt: new Date(),
        }
      : null;
  }

  async getRecentPurchases(_limit?: number): Promise<PurchaseRecord[]> {
    if (!this.healthy) {
      throw new Error('Provider is unhealthy');
    }
    return [];
  }

  async healthCheck(): Promise<boolean> {
    if (this.shouldFailHealthCheck) {
      throw new Error('Health check failed');
    }
    return this.healthy;
  }
}

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  afterEach(() => {
    registry.clear();
  });

  describe('registerProvider', () => {
    it('should register a provider adapter', () => {
      const adapter = new MockAdapter('gumroad');
      registry.registerProvider('gumroad', adapter);

      expect(registry.hasProvider('gumroad')).toBe(true);
    });

    it('should overwrite existing provider registration', () => {
      const adapter1 = new MockAdapter('gumroad');
      const adapter2 = new MockAdapter('gumroad');

      registry.registerProvider('gumroad', adapter1);
      registry.registerProvider('gumroad', adapter2);

      const result = registry.getProvider('gumroad');
      expect(result).toBe(adapter2);
    });
  });

  describe('unregisterProvider', () => {
    it('should unregister a provider adapter', () => {
      const adapter = new MockAdapter('gumroad');
      registry.registerProvider('gumroad', adapter);

      const result = registry.unregisterProvider('gumroad');
      expect(result).toBe(true);
      expect(registry.hasProvider('gumroad')).toBe(false);
    });

    it('should return false if provider not registered', () => {
      const result = registry.unregisterProvider('gumroad');
      expect(result).toBe(false);
    });
  });

  describe('getProvider', () => {
    it('should return registered provider', () => {
      const adapter = new MockAdapter('jinxxy');
      registry.registerProvider('jinxxy', adapter);

      const result = registry.getProvider('jinxxy');
      expect(result).toBe(adapter);
    });

    it('should return undefined for unregistered provider', () => {
      const result = registry.getProvider('gumroad');
      expect(result).toBeUndefined();
    });
  });

  describe('hasProvider', () => {
    it('should return true for registered provider', () => {
      const adapter = new MockAdapter('manual');
      registry.registerProvider('manual', adapter);

      expect(registry.hasProvider('manual')).toBe(true);
    });

    it('should return false for unregistered provider', () => {
      expect(registry.hasProvider('discord_role')).toBe(false);
    });
  });

  describe('listProviders', () => {
    it('should list all registered providers', () => {
      registry.registerProvider('gumroad', new MockAdapter('gumroad'));
      registry.registerProvider('jinxxy', new MockAdapter('jinxxy'));
      registry.registerProvider('manual', new MockAdapter('manual'));

      const providers = registry.listProviders();
      expect(providers).toHaveLength(3);
      expect(providers).toContain('gumroad');
      expect(providers).toContain('jinxxy');
      expect(providers).toContain('manual');
    });

    it('should return empty array when no providers registered', () => {
      const providers = registry.listProviders();
      expect(providers).toHaveLength(0);
    });
  });

  describe('healthCheck', () => {
    it('should return healthy status for healthy provider', async () => {
      const adapter = new MockAdapter('gumroad');
      registry.registerProvider('gumroad', adapter);

      const status = await registry.healthCheck('gumroad');

      expect(status.healthy).toBe(true);
      expect(status.type).toBe('gumroad');
      expect(status.lastChecked).toBeInstanceOf(Date);
      expect(status.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should return unhealthy status for unhealthy provider', async () => {
      const adapter = new MockAdapter('jinxxy');
      adapter.setHealthy(false);
      registry.registerProvider('jinxxy', adapter);

      const status = await registry.healthCheck('jinxxy');

      expect(status.healthy).toBe(false);
      // When healthCheck() returns false (vs throws), registry does not set error
      expect(status.type).toBe('jinxxy');
      expect(status.lastChecked).toBeInstanceOf(Date);
    });

    it('should return unhealthy for unregistered provider', async () => {
      const status = await registry.healthCheck('gumroad');

      expect(status.healthy).toBe(false);
      expect(status.error).toBe('Provider not registered');
    });

    it('should use custom healthCheck method if available', async () => {
      const adapter = new MockAdapter('manual');
      adapter.setShouldFailHealthCheck(true);
      registry.registerProvider('manual', adapter);

      const status = await registry.healthCheck('manual');

      expect(status.healthy).toBe(false);
      expect(status.error).toBe('Health check failed');
    });

    it('should cache health check result', async () => {
      const adapter = new MockAdapter('gumroad');
      registry.registerProvider('gumroad', adapter);

      await registry.healthCheck('gumroad');

      const cached = registry.getCachedHealthStatus('gumroad');
      expect(cached).toBeDefined();
      expect(cached?.healthy).toBe(true);
    });
  });

  describe('healthCheckAll', () => {
    it('should check health of all providers', async () => {
      registry.registerProvider('gumroad', new MockAdapter('gumroad'));
      registry.registerProvider('jinxxy', new MockAdapter('jinxxy'));

      const results = await registry.healthCheckAll();

      expect(results.size).toBe(2);
      expect(results.get('gumroad')?.healthy).toBe(true);
      expect(results.get('jinxxy')?.healthy).toBe(true);
    });
  });

  describe('periodic health checks', () => {
    it('should start and stop periodic health checks', () => {
      registry.registerProvider('gumroad', new MockAdapter('gumroad'));

      registry.startPeriodicHealthChecks();
      // Should not throw if called again
      registry.startPeriodicHealthChecks();

      registry.stopPeriodicHealthChecks();
    });
  });

  describe('clear', () => {
    it('should clear all providers', () => {
      registry.registerProvider('gumroad', new MockAdapter('gumroad'));
      registry.registerProvider('jinxxy', new MockAdapter('jinxxy'));

      registry.clear();

      expect(registry.listProviders()).toHaveLength(0);
    });
  });
});

describe('Global Registry', () => {
  afterEach(() => {
    resetGlobalRegistry();
  });

  it('should return same instance on multiple calls', () => {
    const registry1 = getGlobalRegistry();
    const registry2 = getGlobalRegistry();

    expect(registry1).toBe(registry2);
  });

  it('should reset global registry', () => {
    const registry1 = getGlobalRegistry();
    registry1.registerProvider('gumroad', new MockAdapter('gumroad'));

    resetGlobalRegistry();

    const registry2 = getGlobalRegistry();
    expect(registry2.hasProvider('gumroad')).toBe(false);
  });
});
