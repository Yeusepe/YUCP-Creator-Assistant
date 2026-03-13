/**
 * Tests for Verification Orchestrator
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Verification } from '@yucp/shared';
import type { ProviderAdapter, PurchaseRecord } from '../src/index';
import {
  type BeginVerificationContext,
  type CompleteVerificationContext,
  type HealthCheckableAdapter,
  InMemorySessionStorage,
  type ProviderMode,
  type ProviderRegistry,
  type TenantVerificationConfig,
  type VerificationBindingStorage,
  VerificationOrchestrator,
  type VerificationSessionStorage,
} from '../src/index';

// Mock adapter for testing
class MockOrchestratorAdapter implements HealthCheckableAdapter {
  readonly name: string;
  private healthy = true;
  private beginResult: { authorizationUrl: string; state: string } | null = null;
  private completeResult: {
    success: boolean;
    gumroadUserId?: string;
    error?: string;
  } | null = null;

  constructor(name: string) {
    this.name = name;
  }

  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  setBeginResult(result: { authorizationUrl: string; state: string } | null): void {
    this.beginResult = result;
  }

  setCompleteResult(result: {
    success: boolean;
    gumroadUserId?: string;
    error?: string;
  }): void {
    this.completeResult = result;
  }

  async verifyPurchase(emailOrId: string): Promise<Verification | null> {
    if (!this.healthy) return null;
    return {
      id: `verification-${emailOrId}`,
      userId: 'user-id',
      provider: this.name as Verification['provider'],
      status: 'verified',
      createdAt: new Date(),
    };
  }

  async getRecentPurchases(_limit?: number): Promise<PurchaseRecord[]> {
    if (!this.healthy) throw new Error('Unhealthy');
    return [];
  }

  async healthCheck(): Promise<boolean> {
    return this.healthy;
  }

  // Methods that will be called via type assertion in orchestrator
  async beginVerification(
    _authUserId: string,
    _subjectId?: string,
    _options?: { scope?: string }
  ): Promise<{ authorizationUrl: string; state: string }> {
    if (this.beginResult) return this.beginResult;
    return {
      authorizationUrl: 'https://example.com/oauth',
      state: 'test-state-123',
    };
  }

  async completeVerification(
    _code: string,
    _state: string
  ): Promise<{ success: boolean; gumroadUserId?: string; error?: string }> {
    if (this.completeResult) return this.completeResult;
    return {
      success: true,
      gumroadUserId: 'gumroad-user-123',
    };
  }
}

// Mock registry
class MockRegistry {
  private providers = new Map<ProviderMode, HealthCheckableAdapter>();
  private healthStatus = new Map<ProviderMode, { healthy: boolean }>();

  registerProvider(type: ProviderMode, adapter: HealthCheckableAdapter): void {
    this.providers.set(type, adapter);
  }

  setHealthStatus(type: ProviderMode, healthy: boolean): void {
    this.healthStatus.set(type, { healthy });
  }

  getProvider(type: ProviderMode): HealthCheckableAdapter | undefined {
    return this.providers.get(type);
  }

  hasProvider(type: ProviderMode): boolean {
    return this.providers.has(type);
  }

  listProviders(): ProviderMode[] {
    return Array.from(this.providers.keys());
  }

  async healthCheck(type: ProviderMode): Promise<{
    type: ProviderMode;
    healthy: boolean;
    lastChecked: Date;
    error?: string;
  }> {
    const adapter = this.providers.get(type);
    const status = this.healthStatus.get(type);

    if (!adapter) {
      return {
        type,
        healthy: false,
        lastChecked: new Date(),
        error: 'Provider not registered',
      };
    }

    const healthy = status?.healthy ?? true;
    return {
      type,
      healthy,
      lastChecked: new Date(),
      error: healthy ? undefined : 'Provider is unhealthy',
    };
  }

  async healthCheckAll(): Promise<
    Map<ProviderMode, { type: ProviderMode; healthy: boolean; lastChecked: Date }>
  > {
    const results = new Map();
    for (const type of this.providers.keys()) {
      results.set(type, await this.healthCheck(type));
    }
    return results;
  }

  unregisterProvider(_type: ProviderMode): boolean {
    return false;
  }

  getCachedHealthStatus(
    _type: ProviderMode
  ): { type: ProviderMode; healthy: boolean; lastChecked: Date; error?: string } | undefined {
    return undefined;
  }

  getProviderEntries(): Map<ProviderMode, { adapter: HealthCheckableAdapter; registeredAt: Date }> {
    return new Map();
  }

  startPeriodicHealthChecks(): void {}
  stopPeriodicHealthChecks(): void {}
  clear(): void {}
}

// Mock binding storage
class MockBindingStorage implements VerificationBindingStorage {
  private bindings = new Map<
    string,
    {
      id: string;
      authUserId: string;
      mode: ProviderMode;
      providerUserId?: string;
      verification: Verification;
    }
  >();

  setBinding(binding: {
    id: string;
    authUserId: string;
    mode: ProviderMode;
    providerUserId?: string;
    verification: Verification;
  }): void {
    this.bindings.set(binding.id, binding);
  }

  async get(bindingId: string) {
    return this.bindings.get(bindingId) ?? null;
  }

  async update(_bindingId: string, _verification: Verification): Promise<void> {}

  async delete(bindingId: string): Promise<void> {
    this.bindings.delete(bindingId);
  }
}

describe('VerificationOrchestrator', () => {
  let registry: MockRegistry;
  let orchestrator: VerificationOrchestrator;
  let tenantConfigs: Map<string, TenantVerificationConfig>;
  let bindingStorage: MockBindingStorage;

  beforeEach(() => {
    registry = new MockRegistry();
    tenantConfigs = new Map();
    bindingStorage = new MockBindingStorage();

    orchestrator = new VerificationOrchestrator(registry as unknown as ProviderRegistry, {
      getTenantConfig: async (authUserId) => tenantConfigs.get(authUserId) ?? null,
      bindingStorage,
      checkProviderHealth: false, // Disable for most tests
    });
  });

  describe('beginVerification', () => {
    it('should fail for unknown tenant', async () => {
      const result = await orchestrator.beginVerification('unknown-user', 'gumroad', {
        subjectId: 'user-123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Creator not found');
    });

    it('should fail for disabled provider mode', async () => {
      tenantConfigs.set('user_test1', {
        enabledModes: ['jinxxy'],
      });

      const result = await orchestrator.beginVerification('user_test1', 'gumroad', {
        subjectId: 'user-123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not enabled');
    });

    it('should fail for unregistered provider', async () => {
      tenantConfigs.set('user_test1', {
        enabledModes: ['gumroad'],
      });

      const result = await orchestrator.beginVerification('user_test1', 'gumroad', {
        subjectId: 'user-123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not registered');
    });

    it('should begin Gumroad verification successfully', async () => {
      const adapter = new MockOrchestratorAdapter('gumroad');
      adapter.setBeginResult({
        authorizationUrl: 'https://gumroad.com/oauth',
        state: 'gumroad-state-456',
      });
      registry.registerProvider('gumroad', adapter);

      tenantConfigs.set('user_test1', {
        enabledModes: ['gumroad'],
      });

      const result = await orchestrator.beginVerification('user_test1', 'gumroad', {
        subjectId: 'user-123',
        redirectUri: 'https://example.com/callback',
      });

      expect(result.success).toBe(true);
      expect(result.mode).toBe('gumroad');
      expect(result.authorizationUrl).toBe('https://gumroad.com/oauth');
      expect(result.state).toBe('gumroad-state-456');
      expect(result.verificationSessionId).toBeDefined();
    });

    it('should begin Jinxxy verification (direct, no OAuth)', async () => {
      const adapter = new MockOrchestratorAdapter('jinxxy');
      registry.registerProvider('jinxxy', adapter);

      tenantConfigs.set('user_test1', {
        enabledModes: ['jinxxy'],
      });

      const result = await orchestrator.beginVerification('user_test1', 'jinxxy', {
        subjectId: 'user-123',
      });

      expect(result.success).toBe(true);
      expect(result.mode).toBe('jinxxy');
      expect(result.authorizationUrl).toBeUndefined();
    });

    it('should begin manual verification (direct, no OAuth)', async () => {
      const adapter = new MockOrchestratorAdapter('manual');
      registry.registerProvider('manual', adapter);

      tenantConfigs.set('user_test1', {
        enabledModes: ['manual'],
      });

      const result = await orchestrator.beginVerification('user_test1', 'manual', {
        subjectId: 'user-123',
      });

      expect(result.success).toBe(true);
      expect(result.mode).toBe('manual');
      expect(result.authorizationUrl).toBeUndefined();
    });
  });

  describe('completeVerification', () => {
    it('should fail for invalid session', async () => {
      const result = await orchestrator.completeVerification('invalid-session', {
        code: 'auth-code',
        state: 'state',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid or expired');
    });

    it('should complete Gumroad verification successfully', async () => {
      const adapter = new MockOrchestratorAdapter('gumroad');
      adapter.setCompleteResult({
        success: true,
        gumroadUserId: 'gumroad-user-789',
      });
      registry.registerProvider('gumroad', adapter);

      tenantConfigs.set('user_test1', {
        enabledModes: ['gumroad'],
      });

      // First begin verification
      const beginResult = await orchestrator.beginVerification('user_test1', 'gumroad', {
        subjectId: 'user-123',
      });

      // Then complete it
      const result = await orchestrator.completeVerification(beginResult.verificationSessionId, {
        code: 'auth-code',
        state: beginResult.state ?? '',
      });

      expect(result.success).toBe(true);
      expect(result.mode).toBe('gumroad');
      expect(result.providerUserId).toBe('gumroad-user-789');
      expect(result.verification).toBeDefined();
    });

    it('should handle failed Gumroad completion', async () => {
      const adapter = new MockOrchestratorAdapter('gumroad');
      adapter.setCompleteResult({
        success: false,
        error: 'Invalid authorization code',
      });
      registry.registerProvider('gumroad', adapter);

      tenantConfigs.set('user_test1', {
        enabledModes: ['gumroad'],
      });

      const beginResult = await orchestrator.beginVerification('user_test1', 'gumroad', {
        subjectId: 'user-123',
      });

      const result = await orchestrator.completeVerification(beginResult.verificationSessionId, {
        code: 'invalid-code',
        state: beginResult.state ?? '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid authorization code');
    });

    it('should complete Jinxxy verification with buyer identifier', async () => {
      const adapter = new MockOrchestratorAdapter('jinxxy');
      registry.registerProvider('jinxxy', adapter);

      tenantConfigs.set('user_test1', {
        enabledModes: ['jinxxy'],
      });

      const beginResult = await orchestrator.beginVerification('user_test1', 'jinxxy', {
        subjectId: 'user-123',
      });

      const result = await orchestrator.completeVerification(beginResult.verificationSessionId, {
        buyerIdentifier: 'buyer@example.com',
      });

      expect(result.success).toBe(true);
      expect(result.mode).toBe('jinxxy');
      expect(result.verification).toBeDefined();
    });
  });

  describe('refreshVerification', () => {
    it('should fail without binding storage', async () => {
      const orchestratorNoStorage = new VerificationOrchestrator(
        registry as unknown as ProviderRegistry,
        {
          getTenantConfig: async () => ({ enabledModes: ['gumroad'] }),
        }
      );

      const result = await orchestratorNoStorage.refreshVerification('binding-123');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Binding storage not configured');
    });

    it('should fail for unknown binding', async () => {
      const result = await orchestrator.refreshVerification('unknown-binding');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Binding not found');
    });

    it('should refresh verification successfully', async () => {
      const adapter = new MockOrchestratorAdapter('gumroad');
      registry.registerProvider('gumroad', adapter);

      bindingStorage.setBinding({
        id: 'binding-123',
        authUserId: 'user_test1',
        mode: 'gumroad',
        providerUserId: 'gumroad-user-456',
        verification: {
          id: 'verification-123',
          userId: 'user-123',
          provider: 'gumroad',
          status: 'verified',
          createdAt: new Date(),
        },
      });

      const result = await orchestrator.refreshVerification('binding-123');

      expect(result.success).toBe(true);
    });
  });

  describe('revokeVerification', () => {
    it('should fail without binding storage', async () => {
      const orchestratorNoStorage = new VerificationOrchestrator(
        registry as unknown as ProviderRegistry,
        {
          getTenantConfig: async () => ({ enabledModes: ['gumroad'] }),
        }
      );

      const result = await orchestratorNoStorage.revokeVerification('binding-123');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Binding storage not configured');
    });

    it('should fail for unknown binding', async () => {
      const result = await orchestrator.revokeVerification('unknown-binding');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Binding not found');
    });

    it('should revoke verification successfully', async () => {
      const adapter = new MockOrchestratorAdapter('gumroad');
      registry.registerProvider('gumroad', adapter);

      bindingStorage.setBinding({
        id: 'binding-123',
        authUserId: 'user_test1',
        mode: 'gumroad',
        providerUserId: 'gumroad-user-456',
        verification: {
          id: 'verification-123',
          userId: 'user-123',
          provider: 'gumroad',
          status: 'verified',
          createdAt: new Date(),
        },
      });

      const result = await orchestrator.revokeVerification('binding-123', {
        bindingId: 'binding-123',
        reason: 'User requested',
        notifyProvider: true,
      });

      expect(result.success).toBe(true);
    });
  });

  describe('getEnabledModes', () => {
    it('should return enabled modes for tenant', async () => {
      tenantConfigs.set('user_test1', {
        enabledModes: ['gumroad', 'jinxxy'],
      });

      const modes = await orchestrator.getEnabledModes('user_test1');

      expect(modes).toHaveLength(2);
      expect(modes).toContain('gumroad');
      expect(modes).toContain('jinxxy');
    });

    it('should return empty array for unknown tenant', async () => {
      const modes = await orchestrator.getEnabledModes('unknown-user');
      expect(modes).toHaveLength(0);
    });
  });

  describe('isModeEnabled', () => {
    it('should return true for enabled mode', async () => {
      tenantConfigs.set('user_test1', {
        enabledModes: ['gumroad', 'jinxxy'],
      });

      const result = await orchestrator.isModeEnabled('user_test1', 'gumroad');
      expect(result).toBe(true);
    });

    it('should return false for disabled mode', async () => {
      tenantConfigs.set('user_test1', {
        enabledModes: ['jinxxy'],
      });

      const result = await orchestrator.isModeEnabled('user_test1', 'gumroad');
      expect(result).toBe(false);
    });
  });
});

describe('InMemorySessionStorage', () => {
  let storage: InMemorySessionStorage;

  beforeEach(() => {
    storage = new InMemorySessionStorage();
  });

  it('should store and retrieve session', async () => {
    const session = {
      id: 'session-123',
      authUserId: 'user_test1',
      mode: 'gumroad' as ProviderMode,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
    };

    await storage.store(session);
    const result = await storage.get('session-123');

    expect(result).toBeDefined();
    expect(result?.id).toBe('session-123');
  });

  it('should return null for expired session', async () => {
    const session = {
      id: 'session-123',
      authUserId: 'user_test1',
      mode: 'gumroad' as ProviderMode,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() - 1000), // Expired
    };

    await storage.store(session);
    const result = await storage.get('session-123');

    expect(result).toBeNull();
  });

  it('should find session by state', async () => {
    const session = {
      id: 'session-123',
      authUserId: 'user_test1',
      mode: 'gumroad' as ProviderMode,
      state: 'oauth-state-456',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
    };

    await storage.store(session);
    const result = await storage.getByState('oauth-state-456');

    expect(result).toBeDefined();
    expect(result?.id).toBe('session-123');
  });

  it('should delete session', async () => {
    const session = {
      id: 'session-123',
      authUserId: 'user_test1',
      mode: 'gumroad' as ProviderMode,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
    };

    await storage.store(session);
    await storage.delete('session-123');
    const result = await storage.get('session-123');

    expect(result).toBeNull();
  });
});

describe('Health Check Integration', () => {
  let registry: MockRegistry;
  let orchestrator: VerificationOrchestrator;
  let tenantConfigs: Map<string, TenantVerificationConfig>;

  beforeEach(() => {
    registry = new MockRegistry();
    tenantConfigs = new Map();

    orchestrator = new VerificationOrchestrator(registry as unknown as ProviderRegistry, {
      getTenantConfig: async (authUserId) => tenantConfigs.get(authUserId) ?? null,
      checkProviderHealth: true, // Enable health checks
    });
  });

  it('should fail when provider is unhealthy', async () => {
    const adapter = new MockOrchestratorAdapter('gumroad');
    registry.registerProvider('gumroad', adapter);
    registry.setHealthStatus('gumroad', false);

    tenantConfigs.set('user_test1', {
      enabledModes: ['gumroad'],
    });

    const result = await orchestrator.beginVerification('user_test1', 'gumroad', {
      subjectId: 'user-123',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('unhealthy');
  });

  it('should fallback to healthy provider when primary is unhealthy', async () => {
    const gumroadAdapter = new MockOrchestratorAdapter('gumroad');
    const jinxxyAdapter = new MockOrchestratorAdapter('jinxxy');

    registry.registerProvider('gumroad', gumroadAdapter);
    registry.registerProvider('jinxxy', jinxxyAdapter);
    registry.setHealthStatus('gumroad', false);
    registry.setHealthStatus('jinxxy', true);

    tenantConfigs.set('user_test1', {
      enabledModes: ['gumroad', 'jinxxy'],
      fallbackOrder: ['jinxxy', 'gumroad'],
    });

    const result = await orchestrator.beginVerification('user_test1', 'gumroad', {
      subjectId: 'user-123',
    });

    expect(result.success).toBe(true);
    expect(result.mode).toBe('jinxxy');
  });
});
