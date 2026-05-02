import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import { logger } from './logger';

export interface PublicApiRateLimitStore {
  consume(args: {
    key: string;
    limit: number;
    windowMs: number;
    now?: number;
  }): Promise<PublicApiRateLimitDecision>;
}

export interface PublicApiRateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export interface PublicApiRateLimitResult extends PublicApiRateLimitDecision {
  status: 200 | 429;
  headers: Record<string, string>;
}

export class InMemoryPublicApiRateLimitStore implements PublicApiRateLimitStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  async consume(args: {
    key: string;
    limit: number;
    windowMs: number;
    now?: number;
  }): Promise<PublicApiRateLimitDecision> {
    const now = args.now ?? Date.now();
    const existing = this.buckets.get(args.key);
    const bucket =
      !existing || now >= existing.resetAt ? { count: 0, resetAt: now + args.windowMs } : existing;

    bucket.count += 1;
    this.buckets.set(args.key, bucket);

    const remaining = Math.max(args.limit - bucket.count, 0);
    const retryAfterSeconds = Math.max(Math.ceil((bucket.resetAt - now) / 1000), 0);
    return {
      allowed: bucket.count <= args.limit,
      limit: args.limit,
      remaining,
      resetAt: bucket.resetAt,
      retryAfterSeconds,
    };
  }
}

export class RedisPublicApiRateLimitStore implements PublicApiRateLimitStore {
  private readonly redis: Redis;
  private readonly limiters = new Map<string, RateLimiterRedis>();

  constructor(uri: string) {
    const RedisClient = require('ioredis') as new (uri: string) => Redis;
    this.redis = new RedisClient(uri);
    this.redis.on('error', (error: Error) => {
      logger.error('Public API Redis rate limiter connection error', { error: error.message });
    });
  }

  async consume(args: {
    key: string;
    limit: number;
    windowMs: number;
  }): Promise<PublicApiRateLimitDecision> {
    const limiter = this.getLimiter(args.limit, args.windowMs);
    try {
      const result = await limiter.consume(args.key);
      return {
        allowed: true,
        limit: args.limit,
        remaining: Math.max(result.remainingPoints, 0),
        resetAt: Date.now() + result.msBeforeNext,
        retryAfterSeconds: Math.max(Math.ceil(result.msBeforeNext / 1000), 0),
      };
    } catch (error) {
      const result =
        error && typeof error === 'object'
          ? (error as { msBeforeNext?: number; remainingPoints?: number })
          : {};
      const msBeforeNext =
        typeof result.msBeforeNext === 'number' && Number.isFinite(result.msBeforeNext)
          ? result.msBeforeNext
          : args.windowMs;
      return {
        allowed: false,
        limit: args.limit,
        remaining: Math.max(result.remainingPoints ?? 0, 0),
        resetAt: Date.now() + msBeforeNext,
        retryAfterSeconds: Math.max(Math.ceil(msBeforeNext / 1000), 1),
      };
    }
  }

  private getLimiter(limit: number, windowMs: number): RateLimiterRedis {
    const duration = Math.max(Math.ceil(windowMs / 1000), 1);
    const key = `${limit}:${duration}`;
    const existing = this.limiters.get(key);
    if (existing) return existing;

    const limiter = new RateLimiterRedis({
      storeClient: this.redis,
      keyPrefix: 'yucp:public-api',
      points: limit,
      duration,
      blockDuration: duration,
    });
    this.limiters.set(key, limiter);
    return limiter;
  }
}

export class LocalProcessPublicApiRateLimitStore implements PublicApiRateLimitStore {
  private readonly limiters = new Map<string, RateLimiterMemory>();

  async consume(args: {
    key: string;
    limit: number;
    windowMs: number;
  }): Promise<PublicApiRateLimitDecision> {
    const limiter = this.getLimiter(args.limit, args.windowMs);
    try {
      const result = await limiter.consume(args.key);
      return {
        allowed: true,
        limit: args.limit,
        remaining: Math.max(result.remainingPoints, 0),
        resetAt: Date.now() + result.msBeforeNext,
        retryAfterSeconds: Math.max(Math.ceil(result.msBeforeNext / 1000), 0),
      };
    } catch (error) {
      const result =
        error && typeof error === 'object'
          ? (error as { msBeforeNext?: number; remainingPoints?: number })
          : {};
      const msBeforeNext =
        typeof result.msBeforeNext === 'number' && Number.isFinite(result.msBeforeNext)
          ? result.msBeforeNext
          : args.windowMs;
      return {
        allowed: false,
        limit: args.limit,
        remaining: Math.max(result.remainingPoints ?? 0, 0),
        resetAt: Date.now() + msBeforeNext,
        retryAfterSeconds: Math.max(Math.ceil(msBeforeNext / 1000), 1),
      };
    }
  }

  private getLimiter(limit: number, windowMs: number): RateLimiterMemory {
    const duration = Math.max(Math.ceil(windowMs / 1000), 1);
    const key = `${limit}:${duration}`;
    const existing = this.limiters.get(key);
    if (existing) return existing;

    const limiter = new RateLimiterMemory({
      points: limit,
      duration,
      blockDuration: duration,
    });
    this.limiters.set(key, limiter);
    return limiter;
  }
}

let publicApiRateLimitStore: PublicApiRateLimitStore | null = null;

export function getPublicApiRateLimitStore(): PublicApiRateLimitStore {
  if (publicApiRateLimitStore) return publicApiRateLimitStore;

  const uri = process.env.DRAGONFLY_URI ?? process.env.REDIS_URL;
  if (uri) {
    publicApiRateLimitStore = new RedisPublicApiRateLimitStore(uri);
    logger.info('Using Redis-backed public API rate limiter');
    return publicApiRateLimitStore;
  }

  if ((process.env.NODE_ENV ?? 'development') === 'production') {
    throw new Error('Public API rate limiting requires DRAGONFLY_URI or REDIS_URL in production');
  }

  publicApiRateLimitStore = new LocalProcessPublicApiRateLimitStore();
  logger.info('Using in-process public API rate limiter for dev/test');
  return publicApiRateLimitStore;
}

export async function checkPublicApiRateLimit(args: {
  store: PublicApiRateLimitStore;
  key: string;
  limit: number;
  windowMs: number;
  now?: number;
}): Promise<PublicApiRateLimitResult> {
  const decision = await args.store.consume(args);
  const resetSeconds = Math.ceil(decision.resetAt / 1000);
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(decision.limit),
    'RateLimit-Remaining': String(Math.max(decision.remaining, 0)),
    'RateLimit-Reset': String(resetSeconds),
  };

  if (!decision.allowed) {
    headers['Retry-After'] = String(decision.retryAfterSeconds);
  }

  return {
    ...decision,
    status: decision.allowed ? 200 : 429,
    headers,
  };
}

export function buildPublicApiRateLimitKey(args: {
  routeFamily: string;
  clientAddress: string;
  apiKey?: string | null;
  bearerToken?: string | null;
  userAgent?: string | null;
}): string {
  const authMaterial = args.apiKey ?? args.bearerToken;
  if (authMaterial) {
    return `${args.routeFamily}:auth:${sha256(authMaterial)}`;
  }

  const userAgent = args.userAgent?.trim() || 'unknown';
  return `${args.routeFamily}:ip:${sha256(`${args.clientAddress}:${userAgent}`)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
