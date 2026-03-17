/**
 * State Store for OAuth and Install flows
 *
 * Provides a pluggable backend: Dragonfly (Redis-compatible) when configured,
 * or in-memory for dev/CI when DRAGONFLY_URI/REDIS_URL is unset.
 */

import { createLogger } from '@yucp/shared';
import type Redis from 'ioredis';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

/**
 * Key-value store for OAuth/install state.
 * Values are JSON-serialized strings; TTL is in milliseconds.
 */
export interface StateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * In-memory state store for dev/CI when Dragonfly is not configured.
 */
export class InMemoryStateStore implements StateStore {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs !== undefined ? Date.now() + ttlMs : undefined;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/**
 * Dragonfly/Redis-backed state store using ioredis.
 * Dragonfly is Redis-protocol compatible.
 */
export class DragonflyStateStore implements StateStore {
  private redis: Redis;

  constructor(uri: string) {
    // Dynamic require to avoid loading ioredis when using in-memory store
    const RedisClient = require('ioredis') as new (uri: string) => Redis;
    this.redis = new RedisClient(uri);
    this.redis.on('error', (err: Error) => {
      logger.error('Dragonfly/Redis connection error', { error: err.message });
    });
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    if (ttlMs !== undefined) {
      await this.redis.set(key, value, 'PX', ttlMs);
    } else {
      await this.redis.set(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

let stateStoreInstance: StateStore | null = null;

/**
 * Returns the configured StateStore.
 * Uses Dragonfly when DRAGONFLY_URI or REDIS_URL is set; otherwise InMemoryStateStore.
 */
export function getStateStore(): StateStore {
  if (stateStoreInstance) {
    return stateStoreInstance;
  }

  const uri = process.env.DRAGONFLY_URI ?? process.env.REDIS_URL;
  if (uri) {
    stateStoreInstance = new DragonflyStateStore(uri);
    logger.info('Using Dragonfly/Redis state store');
  } else {
    if (process.env.NODE_ENV === 'production') {
      // In production, an in-memory store loses all state on restart and does not
      // coordinate across replicas. This is a security and reliability risk.
      // Set DRAGONFLY_URI or REDIS_URL to a shared Redis-compatible instance.
      logger.error(
        'SECURITY: No distributed state store configured in production. ' +
          'OAuth and setup-session state will be lost on restart and is not shared ' +
          'across replicas. Set DRAGONFLY_URI or REDIS_URL immediately.'
      );
    }
    stateStoreInstance = new InMemoryStateStore();
    logger.info('Using in-memory state store (set DRAGONFLY_URI for production)');
  }
  return stateStoreInstance;
}
