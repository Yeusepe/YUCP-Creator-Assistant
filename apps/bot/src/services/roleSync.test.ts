/**
 * Role Sync Service Tests
 *
 * Tests for the Discord role sync engine.
 */

import { describe, it, expect, beforeEach, mock, afterEach } from 'bun:test';
import {
  RoleSyncService,
  DiscordRateLimiter,
  type RoleSyncPayload,
  type RoleRemovalPayload,
  type OutboxJob,
} from './roleSync';

// ============================================================================
// MOCKS
// ============================================================================

// Simple mock function type
interface MockFunction {
  (...args: any[]): any;
  mock: {
    calls: any[][];
    results: { type: 'return' | 'throw'; value: any }[];
  };
}

function createMockFn(impl: (...args: any[]) => any): MockFunction {
  const fn = function (this: any, ...args: any[]) {
    const result = impl(...args);
    fn.mock.calls.push(args);
    fn.mock.results.push({ type: 'return', value: result });
    return result;
  } as MockFunction;
  fn.mock = { calls: [], results: [] };
  return fn;
}

// Mock Discord.js types
interface MockGuildMember {
  id: string;
  roles: {
    cache: Map<string, { id: string }>;
    add: MockFunction;
    remove: MockFunction;
  };
}

function createMockGuildMember(hasRole = false): MockGuildMember {
  const rolesCache = new Map<string, { id: string }>();
  if (hasRole) {
    rolesCache.set('role-123', { id: 'role-123' });
  }

  return {
    id: 'user-123',
    roles: {
      cache: rolesCache,
      add: createMockFn(async () => {}),
      remove: createMockFn(async () => {}),
    },
  };
}

function createMockGuild(members: Map<string, MockGuildMember>) {
  return {
    id: 'guild-123',
    members: {
      cache: members,
      fetch: createMockFn(async (userId: string) => {
        const member = members.get(userId);
        if (!member) {
          throw new Error('Unknown Member');
        }
        return member;
      }),
    },
  };
}

function createMockDiscordClient(guilds: Map<string, any>) {
  return {
    guilds: {
      cache: guilds,
    },
  } as any;
}

function createMockConvexClient() {
  const client = {
    _queryMocks: [] as any[],
    _mutationMocks: [] as any[],
    query: createMockFn(async () => []),
    mutation: createMockFn(async () => ({ success: true })),
  };
  return client as any;
}

// ============================================================================
// RATE LIMITER TESTS
// ============================================================================

describe('DiscordRateLimiter', () => {
  let rateLimiter: DiscordRateLimiter;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      child: () => mockLogger,
      warn: () => {},
      info: () => {},
    };
    rateLimiter = new DiscordRateLimiter(mockLogger);
  });

  describe('waitForRateLimit', () => {
    it('should not wait when no rate limit is set', async () => {
      const start = Date.now();
      await rateLimiter.waitForRateLimit('test-route');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(10);
    });

    it('should not wait when remaining calls > 0', async () => {
      rateLimiter.updateFromHeaders('test-route', {
        'x-ratelimit-reset': String((Date.now() + 10000) / 1000),
        'x-ratelimit-remaining': '5',
      });

      const start = Date.now();
      await rateLimiter.waitForRateLimit('test-route');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(10);
    });
  });

  describe('calculateBackoff', () => {
    it('should calculate exponential backoff', () => {
      const baseDelay = 1000;

      expect(rateLimiter.calculateBackoff(0, baseDelay)).toBeLessThan(1500);
      expect(rateLimiter.calculateBackoff(1, baseDelay)).toBeGreaterThan(1000);
      expect(rateLimiter.calculateBackoff(1, baseDelay)).toBeLessThan(2500);
      expect(rateLimiter.calculateBackoff(2, baseDelay)).toBeGreaterThan(2000);
      expect(rateLimiter.calculateBackoff(2, baseDelay)).toBeLessThan(4500);
    });

    it('should cap backoff at max delay', () => {
      const maxDelay = 60000;
      const backoff = rateLimiter.calculateBackoff(10, 1000);
      expect(backoff).toBeLessThanOrEqual(maxDelay);
    });
  });
});

// ============================================================================
// ROLE SYNC SERVICE TESTS
// ============================================================================

describe('RoleSyncService', () => {
  let mockDiscordClient: any;
  let mockConvexClient: any;
  let mockGuild: any;
  let mockMember: MockGuildMember;
  let service: RoleSyncService;

  beforeEach(() => {
    mockMember = createMockGuildMember(false);
    mockGuild = createMockGuild(new Map([['user-123', mockMember]]));
    mockDiscordClient = createMockDiscordClient(new Map([['guild-123', mockGuild]]));
    mockConvexClient = createMockConvexClient();

    service = new RoleSyncService({
      convexUrl: 'https://test.convex.cloud',
      apiSecret: 'test-secret',
      discordClient: mockDiscordClient,
      pollIntervalMs: 100,
      logLevel: 'debug',
    });

    // Override internal convex client with mock
    (service as any).convexClient = mockConvexClient;
  });

  afterEach(() => {
    service.stop();
  });

  describe('processRoleSyncJob', () => {
    it('should add role when member does not have it', async () => {
      const job: OutboxJob = {
        _id: 'job-123' as any,
        tenantId: 'tenant-123' as any,
        jobType: 'role_sync',
        payload: {
          subjectId: 'subject-123' as any,
          entitlementId: 'entitlement-123' as any,
          discordUserId: 'user-123',
        } as RoleSyncPayload,
        status: 'pending',
        retryCount: 0,
        maxRetries: 5,
      };

      // Mock Convex responses with sequential returns
      let queryCallCount = 0;
      mockConvexClient.query = createMockFn(async () => {
        queryCallCount++;
        if (queryCallCount === 1) {
          return { found: true, entitlement: { status: 'active', productId: 'product-123' } };
        }
        return [{ guildId: 'guild-123', verifiedRoleId: 'role-456', enabled: true }];
      });

      await (service as any).processJob(job);

      expect(mockMember.roles.add.mock.calls.length).toBeGreaterThan(0);
      expect(mockMember.roles.add.mock.calls[0][0]).toBe('role-456');
    });

    it('should skip when entitlement is not active', async () => {
      const job: OutboxJob = {
        _id: 'job-123' as any,
        tenantId: 'tenant-123' as any,
        jobType: 'role_sync',
        payload: {
          subjectId: 'subject-123' as any,
          entitlementId: 'entitlement-123' as any,
          discordUserId: 'user-123',
        } as RoleSyncPayload,
        status: 'pending',
        retryCount: 0,
        maxRetries: 5,
      };

      mockConvexClient.query = createMockFn(async () => ({
        found: true,
        entitlement: { status: 'revoked', productId: 'product-123' },
      }));

      await (service as any).processJob(job);

      expect(mockMember.roles.add.mock.calls.length).toBe(0);
    });

    it('should handle missing Discord user ID', async () => {
      const job: OutboxJob = {
        _id: 'job-123' as any,
        tenantId: 'tenant-123' as any,
        jobType: 'role_sync',
        payload: {
          subjectId: 'subject-123' as any,
          entitlementId: 'entitlement-123' as any,
          discordUserId: undefined,
        } as RoleSyncPayload,
        status: 'pending',
        retryCount: 0,
        maxRetries: 5,
      };

      // processRoleSyncJob throws directly before try/catch
      await expect((service as any).processRoleSyncJob(job)).rejects.toThrow('No Discord user ID');
    });
  });

  describe('processRoleRemovalJob', () => {
    it('should remove role from member', async () => {
      mockMember = createMockGuildMember(true); // Has role
      mockGuild = createMockGuild(new Map([['user-123', mockMember]]));
      mockDiscordClient = createMockDiscordClient(new Map([['guild-123', mockGuild]]));
      (service as any).discordClient = mockDiscordClient;

      const job: OutboxJob = {
        _id: 'job-123' as any,
        tenantId: 'tenant-123' as any,
        jobType: 'role_removal',
        payload: {
          subjectId: 'subject-123' as any,
          entitlementId: 'entitlement-123' as any,
          guildId: 'guild-123',
          roleId: 'role-123',
          discordUserId: 'user-123',
        } as RoleRemovalPayload,
        status: 'pending',
        retryCount: 0,
        maxRetries: 5,
      };

      await (service as any).processRoleRemovalJob(job);

      expect(mockMember.roles.remove.mock.calls.length).toBeGreaterThan(0);
      expect(mockMember.roles.remove.mock.calls[0][0]).toBe('role-123');
    });
  });
});
