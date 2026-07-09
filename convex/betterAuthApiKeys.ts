import { v } from 'convex/values';
import { components } from './_generated/api';
import { mutation, query } from './_generated/server';
import { createAuth } from './auth';
import { requireApiSecret } from './lib/apiAuth';

const PUBLIC_API_KEY_PREFIX = 'ypsk_';
const PUBLIC_API_KEY_PERMISSION_NAMESPACE = 'publicApi';
const PUBLIC_API_KEY_METADATA_KIND = 'public-api';

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

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return null;
}

function parsePermissionStatements(value: unknown): Record<string, string[]> | null {
  const record = parseJsonRecord(value);
  if (!record) {
    return null;
  }

  const normalized = Object.fromEntries(
    Object.entries(record)
      .map(([key, permissions]) => [
        key,
        Array.isArray(permissions)
          ? permissions.filter((entry): entry is string => typeof entry === 'string')
          : [],
      ])
      .filter(([, permissions]) => permissions.length > 0)
  );

  return Object.keys(normalized).length > 0 ? normalized : null;
}

type SerializableApiKeyRecord = {
  id?: string;
  _id?: string;
  userId?: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  enabled: boolean | null;
  permissions?: unknown;
  metadata?: unknown;
  referenceId?: string | null;
  lastRequest?: unknown;
  expiresAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

const API_KEY_SERIALIZATION_SELECT = [
  '_id',
  'userId',
  'name',
  'start',
  'prefix',
  'enabled',
  'permissions',
  'metadata',
  'lastRequest',
  'expiresAt',
  'createdAt',
  'updatedAt',
  'referenceId',
];

function serializeApiKeyRecord(value: SerializableApiKeyRecord | null) {
  if (!value) {
    return null;
  }

  const id = value.id ?? value._id ?? '';
  if (id.length === 0 || typeof value.userId !== 'string' || value.userId.length === 0) {
    return null;
  }

  const meta = parseJsonRecord(value.metadata);

  // Accept authUserId directly; fall back to tenantId for keys issued before migration.
  const resolvedAuthUserId =
    meta && typeof meta.authUserId === 'string'
      ? meta.authUserId
      : meta && typeof meta.tenantId === 'string'
        ? meta.tenantId
        : null;

  const metadata =
    meta && typeof meta.kind === 'string' && resolvedAuthUserId !== null
      ? {
          kind: meta.kind as string,
          authUserId: resolvedAuthUserId,
        }
      : null;

  return {
    id,
    userId: value.userId,
    name: value.name,
    start: value.start,
    prefix: value.prefix,
    enabled: value.enabled !== false,
    permissions: parsePermissionStatements(value.permissions),
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
      authUserId: v.string(),
    }),
    v.null()
  ),
  lastRequestAt: v.union(v.number(), v.null()),
  expiresAt: v.union(v.number(), v.null()),
  createdAt: v.union(v.number(), v.null()),
  updatedAt: v.union(v.number(), v.null()),
});

interface BetterAuthServerApi {
  listApiKeys(): Promise<
    Array<{
      id: string;
      userId?: string;
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
    }>
  >;
  getApiKey(args: { query: { id: string } }): Promise<{
    id: string;
    userId?: string;
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
  } | null>;
  createApiKey(args: {
    body: {
      userId: string;
      name: string;
      prefix: string;
      expiresIn?: number | null;
      metadata: {
        kind: string;
        authUserId: string;
      };
      referenceId?: string;
      permissions: Record<string, string[]>;
    };
  }): Promise<{
    key: string;
    id: string;
    userId?: string;
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
      userId?: string;
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
  updateApiKey(args: {
    body: {
      keyId: string;
      enabled?: boolean;
    };
  }): Promise<{
    id: string;
    userId?: string;
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
}

function isManagedPublicApiKeyForAuthUser(
  value: ReturnType<typeof serializeApiKeyRecord>,
  authUserId: string
): value is NonNullable<ReturnType<typeof serializeApiKeyRecord>> {
  return (
    value !== null &&
    value.id.length > 0 &&
    value.metadata?.kind === PUBLIC_API_KEY_METADATA_KIND &&
    value.metadata.authUserId === authUserId
  );
}

export const listApiKeys = query({
  args: {
    apiSecret: v.string(),
  },
  returns: v.array(SerializedApiKey),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'apikey',
      select: API_KEY_SERIALIZATION_SELECT,
      paginationOpts: { cursor: null, numItems: 100 },
    })) as {
      page: SerializableApiKeyRecord[];
    };

    return result.page.map((record) => {
      const serialized = serializeApiKeyRecord(record);
      if (!serialized) {
        throw new Error('Better Auth returned an API key record without an owner');
      }
      return serialized;
    });
  },
});

export const listApiKeysForAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.array(SerializedApiKey),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'apikey',
      where: [{ field: 'referenceId', operator: 'eq', value: args.authUserId }],
      select: API_KEY_SERIALIZATION_SELECT,
      paginationOpts: { cursor: null, numItems: 100 },
    })) as {
      page: SerializableApiKeyRecord[];
    };

    return result.page
      .map((record) => serializeApiKeyRecord(record))
      .filter((record): record is NonNullable<typeof record> =>
        isManagedPublicApiKeyForAuthUser(record, args.authUserId)
      )
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  },
});

export const getApiKey = query({
  args: {
    apiSecret: v.string(),
    keyId: v.string(),
  },
  returns: v.union(SerializedApiKey, v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const result = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'apikey',
      where: [{ field: '_id', operator: 'eq', value: args.keyId }],
      select: API_KEY_SERIALIZATION_SELECT,
    })) as SerializableApiKeyRecord | null;
    return serializeApiKeyRecord(result);
  },
});

export const createApiKey = mutation({
  args: {
    apiSecret: v.string(),
    userId: v.string(),
    authUserId: v.string(),
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
        userId: args.authUserId,
        name: args.name,
        prefix: PUBLIC_API_KEY_PREFIX,
        expiresIn: args.expiresIn,
        referenceId: args.authUserId,
        metadata: {
          kind: PUBLIC_API_KEY_METADATA_KIND,
          authUserId: args.authUserId,
        },
        permissions: {
          [PUBLIC_API_KEY_PERMISSION_NAMESPACE]: args.scopes,
        },
      },
    });
    const stored = (await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'apikey',
        update: {
          referenceId: args.authUserId,
        },
        where: [{ field: '_id', operator: 'eq', value: created.id }],
      },
    })) as SerializableApiKeyRecord;
    const serialized = serializeApiKeyRecord(stored);
    if (!serialized) {
      throw new Error('Better Auth returned an API key record without an owner');
    }

    return {
      key: created.key,
      apiKey: serialized,
    };
  },
});

export const backfillApiKeyReferenceIds = mutation({
  args: {
    apiSecret: v.string(),
    ownerUserId: v.string(),
    authUserId: v.string(),
  },
  returns: v.object({
    updatedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'apikey',
      where: [{ field: 'userId', operator: 'eq', value: args.ownerUserId }],
      select: API_KEY_SERIALIZATION_SELECT,
      paginationOpts: { cursor: null, numItems: 100 },
    })) as {
      page: SerializableApiKeyRecord[];
    };

    const legacyKeys = result.page
      .map((record) => serializeApiKeyRecord(record))
      .filter((record): record is NonNullable<typeof record> =>
        isManagedPublicApiKeyForAuthUser(record, args.authUserId)
      )
      .filter((record) => record.id.length > 0);

    let updatedCount = 0;
    for (const key of legacyKeys) {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: 'apikey',
          update: {
            referenceId: args.authUserId,
          },
          where: [{ field: '_id', operator: 'eq', value: key.id }],
        },
      });
      updatedCount += 1;
    }

    return { updatedCount };
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

    const keyId = result.key?.id;
    const stored =
      result.valid && typeof keyId === 'string' && keyId.length > 0
        ? ((await ctx.runQuery(components.betterAuth.adapter.findOne, {
            model: 'apikey',
            where: [{ field: '_id', operator: 'eq', value: keyId }],
            select: API_KEY_SERIALIZATION_SELECT,
          })) as SerializableApiKeyRecord | null)
        : null;
    const serializedKey = serializeApiKeyRecord(stored ?? result.key);

    return {
      valid: result.valid && serializedKey !== null,
      error: result.error
        ? {
            code: result.error.code,
            message: result.error.message ?? null,
          }
        : null,
      key: serializedKey,
    };
  },
});

export const updateApiKey = mutation({
  args: {
    apiSecret: v.string(),
    keyId: v.string(),
    enabled: v.optional(v.boolean()),
  },
  returns: SerializedApiKey,
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const auth = createAuth(ctx);
    const api = auth.api as unknown as BetterAuthServerApi;
    await api.updateApiKey({
      body: {
        keyId: args.keyId,
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      },
    });
    const updated = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'apikey',
      where: [{ field: '_id', operator: 'eq', value: args.keyId }],
      select: API_KEY_SERIALIZATION_SELECT,
    })) as SerializableApiKeyRecord | null;
    const serialized = serializeApiKeyRecord(updated);
    if (!serialized) {
      throw new Error('Better Auth returned an API key record without an owner');
    }
    return serialized;
  },
});
