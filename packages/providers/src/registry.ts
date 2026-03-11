/**
 * Provider Registry
 *
 * Centralized registry for provider adapters.
 * Maps provider types to adapter instances and provides health checking.
 *
 * @example
 * ```ts
 * const registry = new ProviderRegistry();
 * registry.registerProvider('gumroad', gumroadAdapter);
 * registry.registerProvider('jinxxy', jinxxyAdapter);
 *
 * const adapter = registry.getProvider('gumroad');
 * const isHealthy = await registry.healthCheck('gumroad');
 * ```
 */

import type { ProviderAdapter } from './index';

/** Supported provider types in the system */
export type ProviderType = 'gumroad' | 'discord_role' | 'jinxxy' | 'manual' | 'vrchat';

/** Provider mode that a tenant can enable */
export type ProviderMode = ProviderType;

/** Health status of a provider */
export interface ProviderHealthStatus {
  /** Provider type */
  type: ProviderType;
  /** Whether the provider is healthy */
  healthy: boolean;
  /** Timestamp of last health check */
  lastChecked: Date;
  /** Error message if unhealthy */
  error?: string;
  /** Response time in milliseconds */
  responseTimeMs?: number;
}

/** Provider adapter with optional health check capability */
export interface HealthCheckableAdapter extends ProviderAdapter {
  /** Optional health check method */
  healthCheck?(): Promise<boolean>;
}

/** Registry entry containing adapter and metadata */
interface RegistryEntry {
  adapter: HealthCheckableAdapter;
  registeredAt: Date;
  lastHealthCheck?: ProviderHealthStatus;
}

/**
 * Provider Registry
 *
 * Manages provider adapters and provides health checking.
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderType, RegistryEntry>();
  private readonly healthCheckIntervalMs: number;
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  constructor(options?: { healthCheckIntervalMs?: number }) {
    this.healthCheckIntervalMs = options?.healthCheckIntervalMs ?? 60000; // Default 1 minute
  }

  /**
   * Register a provider adapter.
   *
   * @param type - Provider type
   * @param adapter - Provider adapter instance
   */
  registerProvider(type: ProviderType, adapter: HealthCheckableAdapter): void {
    this.providers.set(type, {
      adapter,
      registeredAt: new Date(),
    });
  }

  /**
   * Unregister a provider adapter.
   *
   * @param type - Provider type to unregister
   */
  unregisterProvider(type: ProviderType): boolean {
    return this.providers.delete(type);
  }

  /**
   * Get a provider adapter by type.
   *
   * @param type - Provider type
   * @returns Provider adapter or undefined if not registered
   */
  getProvider(type: ProviderType): HealthCheckableAdapter | undefined {
    return this.providers.get(type)?.adapter;
  }

  /**
   * Check if a provider is registered.
   *
   * @param type - Provider type
   */
  hasProvider(type: ProviderType): boolean {
    return this.providers.has(type);
  }

  /**
   * List all registered providers.
   *
   * @returns Array of registered provider types
   */
  listProviders(): ProviderType[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Get all registered provider entries with metadata.
   *
   * @returns Map of provider types to registry entries
   */
  getProviderEntries(): Map<ProviderType, RegistryEntry> {
    return new Map(this.providers);
  }

  /**
   * Check health of a specific provider.
   *
   * @param type - Provider type to check
   * @returns Health status
   */
  async healthCheck(type: ProviderType): Promise<ProviderHealthStatus> {
    const entry = this.providers.get(type);

    if (!entry) {
      return {
        type,
        healthy: false,
        lastChecked: new Date(),
        error: 'Provider not registered',
      };
    }

    const startTime = Date.now();

    try {
      // Use adapter's healthCheck method if available
      if (entry.adapter.healthCheck) {
        const healthy = await entry.adapter.healthCheck();
        const responseTimeMs = Date.now() - startTime;

        const status: ProviderHealthStatus = {
          type,
          healthy,
          lastChecked: new Date(),
          responseTimeMs,
        };

        entry.lastHealthCheck = status;
        return status;
      }

      // Default health check: try to get recent purchases
      // This is a lightweight operation that verifies API connectivity
      await entry.adapter.getRecentPurchases(1);

      const responseTimeMs = Date.now() - startTime;
      const status: ProviderHealthStatus = {
        type,
        healthy: true,
        lastChecked: new Date(),
        responseTimeMs,
      };

      entry.lastHealthCheck = status;
      return status;
    } catch (error) {
      const responseTimeMs = Date.now() - startTime;
      const status: ProviderHealthStatus = {
        type,
        healthy: false,
        lastChecked: new Date(),
        error: error instanceof Error ? error.message : 'Unknown error',
        responseTimeMs,
      };

      entry.lastHealthCheck = status;
      return status;
    }
  }

  /**
   * Check health of all registered providers.
   *
   * @returns Map of provider types to health status
   */
  async healthCheckAll(): Promise<Map<ProviderType, ProviderHealthStatus>> {
    const results = new Map<ProviderType, ProviderHealthStatus>();

    await Promise.all(
      this.listProviders().map(async (type) => {
        const status = await this.healthCheck(type);
        results.set(type, status);
      })
    );

    return results;
  }

  /**
   * Get cached health status for a provider.
   * Returns the last health check result without performing a new check.
   *
   * @param type - Provider type
   */
  getCachedHealthStatus(type: ProviderType): ProviderHealthStatus | undefined {
    return this.providers.get(type)?.lastHealthCheck;
  }

  /**
   * Start periodic health checks.
   * Calls healthCheckAll at the configured interval.
   */
  startPeriodicHealthChecks(): void {
    if (this.healthCheckTimer) {
      return; // Already running
    }

    // Run initial check
    this.healthCheckAll().catch((error) => {
      console.error('ProviderRegistry: Initial health check failed', error);
    });

    // Schedule periodic checks
    this.healthCheckTimer = setInterval(() => {
      this.healthCheckAll().catch((error) => {
        console.error('ProviderRegistry: Periodic health check failed', error);
      });
    }, this.healthCheckIntervalMs);
  }

  /**
   * Stop periodic health checks.
   */
  stopPeriodicHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  /**
   * Clear all registered providers.
   */
  clear(): void {
    this.stopPeriodicHealthChecks();
    this.providers.clear();
  }
}

/**
 * Global default registry instance.
 * Can be used for simple use cases where a single registry is sufficient.
 */
let globalRegistry: ProviderRegistry | undefined;

/**
 * Get the global provider registry instance.
 * Creates one if it doesn't exist.
 */
export function getGlobalRegistry(): ProviderRegistry {
  if (!globalRegistry) {
    globalRegistry = new ProviderRegistry();
  }
  return globalRegistry;
}

/**
 * Reset the global registry (useful for testing).
 */
export function resetGlobalRegistry(): void {
  if (globalRegistry) {
    globalRegistry.clear();
  }
  globalRegistry = undefined;
}
