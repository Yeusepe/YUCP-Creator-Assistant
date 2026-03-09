import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { createAuth } from './auth';

const PUBLIC_API_KEY_PREFIX = 'ypsk_';
const PUBLIC_API_KEY_PERMISSION_NAMESPACE = 'publicApi';
const PUBLIC_API_KEY_METADATA_KIND = 'public-api';

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

function toTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function serializeApiKeyRecord(
  value: {
    id: string;
    userId: string;
    name: string | null;
    start: string | null;
    prefix: string | null;
    enabled: boolean;
    permissions?: Record<string, string[]> | null;
    metadata?: unknown;
    lastRequest?: unknown;
    expiresAt?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
  } | null
) {
  if (!value) {
    return null;
  }

  const metadata =
    value.metadata &&
    typeof value.metadata === 'object' &&
    !Array.isArray(value.metadata) &&
    typeof (value.metadata as Record<string, unknown>).kind === 'string' &&
    typeof (value.metadata as Record<string, unknown>).tenantId === 'string'
      ? {
          kind: (value.metadata as Record<string, unknown>).kind as string,
          tenantId: (value.metadata as Record<string, unknown>).tenantId as string,
        }
      : null;

  return {
    id: value.id,
    userId: value.userId,
    name: value.name,
    start: value.start,
    prefix: value.prefix,
    enabled: value.enabled,
    permissions: value.permissions ?? null,
    metadata,
    lastRequestAt: toTimestamp(value.lastRequest),
    expiresAt: toTimestamp(value.expiresAt),
    createdAt: toTimestamp(value.createdAt),
    updatedAt: toTimestamp(value.updatedAt),
  };
}

const SerializedApiKey = v.object({
  id: v.string(),
  userId: v.string(),
  name: v.union(v.string(), v.null()),
  start: v.union(v.string(), v.null()),
  prefix: v.union(v.string(), v.null()),
  enabled: v.boolean(),
  permissions: v.union(v.record(v.string(), v.array(v.string())), v.null()),
  metadata: v.union(
    v.object({
      kind: v.string(),
      tenantId: v.string(),
    }),
    v.null()
  ),
  lastRequestAt: v.union(v.number(), v.null()),
  expiresAt: v.union(v.number(), v.null()),
  createdAt: v.union(v.number(), v.null()),
  updatedAt: v.union(v.number(), v.null()),
});

interface BetterAuthServerApi {
  createApiKey(args: {
    body: {
      userId: string;
      name: string;
      prefix: string;
      expiresIn?: number | null;
      metadata: {
        kind: string;
        tenantId: string;
      };
      permissions: Record<string, string[]>;
    };
  }): Promise<{
    key: string;
    id: string;
    userId: string;
    name: string | null;
    start: string | null;
    prefix: string | null;
    enabled: boolean;
    permissions?: Record<string, string[]> | null;
    metadata?: unknown;
    lastRequest?: unknown;
    expiresAt?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
  }>;
  verifyApiKey(args: {
    body: {
      key: string;
      permissions?: Record<string, string[]>;
    };
  }): Promise<{
    valid: boolean;
    error: { code: string; message?: string } | null;
    key: {
      id: string;
      userId: string;
      name: string | null;
      start: string | null;
      prefix: string | null;
      enabled: boolean;
      permissions?: Record<string, string[]> | null;
      metadata?: unknown;
      lastRequest?: unknown;
      expiresAt?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
    } | null;
  }>;
}

export const createApiKey = mutation({
  args: {
    apiSecret: v.string(),
    userId: v.string(),
    tenantId: v.id('tenants'),
    name: v.string(),
    scopes: v.array(v.string()),
    expiresIn: v.optional(v.union(v.number(), v.null())),
  },
  returns: v.object({
    key: v.string(),
    apiKey: SerializedApiKey,
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const auth = createAuth(ctx);
    const api = auth.api as unknown as BetterAuthServerApi;
    const created = await api.createApiKey({
      body: {
        userId: args.userId,
        name: args.name,
        prefix: PUBLIC_API_KEY_PREFIX,
        expiresIn: args.expiresIn,
        metadata: {
          kind: PUBLIC_API_KEY_METADATA_KIND,
          tenantId: args.tenantId,
        },
        permissions: {
          [PUBLIC_API_KEY_PERMISSION_NAMESPACE]: args.scopes,
        },
      },
    });
    const serialized = serializeApiKeyRecord(created);
    if (!serialized) {
      throw new Error('Better Auth returned an empty API key record');
    }

    return {
      key: created.key,
      apiKey: serialized,
    };
  },
});

export const verifyApiKey = mutation({
  args: {
    apiSecret: v.string(),
    key: v.string(),
    scopes: v.optional(v.array(v.string())),
  },
  returns: v.object({
    valid: v.boolean(),
    error: v.union(
      v.object({
        code: v.string(),
        message: v.union(v.string(), v.null()),
      }),
      v.null()
    ),
    key: v.union(SerializedApiKey, v.null()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const auth = createAuth(ctx);
    const api = auth.api as unknown as BetterAuthServerApi;
    const result = await api.verifyApiKey({
      body: {
        key: args.key,
        permissions:
          args.scopes && args.scopes.length > 0
            ? {
                [PUBLIC_API_KEY_PERMISSION_NAMESPACE]: args.scopes,
              }
            : undefined,
      },
    });

    return {
      valid: result.valid,
      error: result.error
        ? {
            code: result.error.code,
            message: result.error.message ?? null,
          }
        : null,
      key: serializeApiKeyRecord(result.key),
    };
  },
});
