import { afterAll, afterEach, beforeAll } from 'bun:test';
import { ConvexHttpClient } from 'convex/browser';
import type { Doc, Id, TableNames } from '../../../../../convex/_generated/dataModel';
import {
  API_SECRET,
  BACKEND_URL,
  INTERNAL_SERVICE_AUTH_SECRET,
  SITE_URL,
} from '../../../../../ops/convex-real/config';
import { type BuiltApiApp, buildApp } from '../../support/buildApp';

export const E2E_ENCRYPTION_SECRET = `e2e-${crypto.randomUUID()}`;

type HarnessState = {
  app: BuiltApiApp;
  componentClient: BetterAuthComponentClient;
  convex: RealConvex;
};

type BetterAuthComponentClient = ConvexHttpClient & {
  function<T>(name: string, componentPath: string, args: unknown): Promise<T>;
  setAdminAuth(token: string, actingAsIdentity?: unknown): void;
};

type RealConvex = {
  action<TResult = unknown>(reference: unknown, args: unknown): Promise<TResult>;
  clearAll(): Promise<void>;
  collect<TableName extends TableNames>(tableName: TableName): Promise<Array<Doc<TableName>>>;
  insert<TableName extends TableNames>(
    tableName: TableName,
    value: Record<string, unknown>
  ): Promise<Id<TableName>>;
  mutation<TResult = unknown>(reference: unknown, args: unknown): Promise<TResult>;
  query<TResult = unknown>(reference: unknown, args: unknown): Promise<TResult>;
};

type RealConvexHarnessModule = {
  getRealBackendAdminKey(): Promise<string>;
  makeRealConvex(): Promise<RealConvex>;
};

type BetterAuthUserSeed = {
  authUserId: string;
  email: string;
  name: string;
};

type JsonResponse<TBody> = {
  body: TBody;
  response: Response;
};

let state: HarnessState | null = null;
const seededAuthUserIds = new Set<string>();
const convexRealHarnessPath = ['..', '..', '..', '..', '..', 'ops', 'convex-real', 'harness'].join(
  '/'
);

async function loadRealConvexHarness(): Promise<RealConvexHarnessModule> {
  return (await import(convexRealHarnessPath)) as RealConvexHarnessModule;
}

function requireState(): HarnessState {
  if (!state) {
    throw new Error('Real API E2E harness has not been initialized');
  }
  return state;
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function getStringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === 'string' && fieldValue.length > 0 ? fieldValue : null;
}

function eqWhere(field: string, value: string) {
  return [{ field, operator: 'eq' as const, value }];
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function hashPublicApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return toBase64Url(new Uint8Array(digest));
}

function createRawPublicApiKey(): string {
  return `ypsk_${toHex(crypto.getRandomValues(new Uint8Array(24)))}`;
}

async function callBetterAuthComponent<T>(name: string, args: unknown): Promise<T> {
  return await requireState().componentClient.function<T>(name, 'betterAuth', args);
}

async function deleteBetterAuthRowsForUser(authUserId: string): Promise<void> {
  await callBetterAuthComponent('adapter:deleteMany', {
    input: { model: 'apikey', where: eqWhere('referenceId', authUserId) },
    paginationOpts: { cursor: null, numItems: 100 },
  });
  await callBetterAuthComponent('adapter:deleteMany', {
    input: { model: 'session', where: eqWhere('userId', authUserId) },
    paginationOpts: { cursor: null, numItems: 100 },
  });
  await callBetterAuthComponent('adapter:deleteMany', {
    input: { model: 'account', where: eqWhere('userId', authUserId) },
    paginationOpts: { cursor: null, numItems: 100 },
  });
  await callBetterAuthComponent('adapter:deleteMany', {
    input: { model: 'user', where: eqWhere('_id', authUserId) },
    paginationOpts: { cursor: null, numItems: 100 },
  });
}

async function clearSeededState(): Promise<void> {
  const current = state;
  if (!current) return;

  await current.convex.clearAll();
  const authUserIds = [...seededAuthUserIds];
  seededAuthUserIds.clear();
  const cleanupErrors: unknown[] = [];
  for (const authUserId of authUserIds) {
    try {
      await deleteBetterAuthRowsForUser(authUserId);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Failed to clean up BetterAuth seed rows');
  }
}

export function installRealApiHarness(): void {
  beforeAll(async () => {
    const { getRealBackendAdminKey, makeRealConvex } = await loadRealConvexHarness();
    const convex = await makeRealConvex();
    const componentClient = new ConvexHttpClient(BACKEND_URL, {
      skipConvexDeploymentUrlCheck: true,
    }) as BetterAuthComponentClient;
    componentClient.setAdminAuth(await getRealBackendAdminKey());
    const app = buildApp({
      baseUrl: 'http://127.0.0.1:3001',
      frontendUrl: 'http://127.0.0.1:3000',
      convexUrl: BACKEND_URL,
      convexSiteUrl: SITE_URL,
      convexApiSecret: API_SECRET,
      encryptionSecret: E2E_ENCRYPTION_SECRET,
      internalServiceAuthSecret: INTERNAL_SERVICE_AUTH_SECRET,
      internalRpcSharedSecret: `e2e-rpc-${crypto.randomUUID()}`,
    });
    state = { app, componentClient, convex };
  });

  afterEach(async () => {
    await clearSeededState();
  });

  afterAll(async () => {
    await clearSeededState();
    state?.app.dispose();
    state = null;
  });
}

export function getRealApiHarness(): HarnessState {
  return requireState();
}

export async function createBetterAuthUser(
  input: { email?: string; name?: string } = {}
): Promise<BetterAuthUserSeed> {
  const suffix = uniqueSuffix();
  const email = input.email ?? `e2e-${suffix}@example.com`;
  const name = input.name ?? `E2E User ${suffix}`;
  const now = Date.now();

  const created = await callBetterAuthComponent<unknown>('adapter:create', {
    input: {
      model: 'user',
      data: {
        name,
        email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
    select: ['_id', 'id', 'email', 'name'],
  });

  let authUserId = getStringField(created, '_id') ?? getStringField(created, 'id');
  if (!authUserId) {
    const stored = await callBetterAuthComponent<unknown>('adapter:findOne', {
      model: 'user',
      where: eqWhere('email', email),
      select: ['_id', 'id'],
    });
    authUserId = getStringField(stored, '_id') ?? getStringField(stored, 'id');
  }
  if (!authUserId) {
    throw new Error('Better Auth user seed did not return an auth user id');
  }

  seededAuthUserIds.add(authUserId);
  return { authUserId, email, name };
}

export async function createPublicApiKey(
  authUserId: string,
  scopes: string[],
  name = 'E2E public API key'
): Promise<string> {
  const key = createRawPublicApiKey();
  const now = Date.now();
  await callBetterAuthComponent('adapter:create', {
    input: {
      model: 'apikey',
      data: {
        configId: 'default',
        createdAt: now,
        enabled: true,
        expiresAt: null,
        key: await hashPublicApiKey(key),
        lastRefillAt: null,
        lastRequest: null,
        metadata: JSON.stringify({ kind: 'public-api', authUserId }),
        name,
        permissions: JSON.stringify({ publicApi: scopes }),
        prefix: 'ypsk_',
        rateLimitEnabled: true,
        rateLimitMax: 1000,
        rateLimitTimeWindow: 86400000,
        referenceId: authUserId,
        refillAmount: null,
        refillInterval: null,
        remaining: null,
        requestCount: 0,
        start: key.slice(0, 6),
        updatedAt: now,
        userId: authUserId,
      },
    },
  });
  return key;
}

export async function apiJson<TBody = Record<string, unknown>>(
  path: string,
  init?: RequestInit
): Promise<JsonResponse<TBody>> {
  const response = await requireState().app.fetch(path, init);
  const text = await response.text();
  const body = (text ? JSON.parse(text) : null) as TBody;
  return { body, response };
}

export function apiKeyHeaders(apiKey: string): HeadersInit {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
  };
}

export async function hashLicenseKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(E2E_ENCRYPTION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(key));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function seedSubject(
  authUserId: string,
  input: { discordUserId?: string } = {}
): Promise<Id<'subjects'>> {
  const now = Date.now();
  return await requireState().convex.insert('subjects', {
    primaryDiscordUserId: input.discordUserId ?? `discord_${uniqueSuffix()}`,
    authUserId,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
}

export async function seedProductCatalog(input: {
  authUserId: string;
  productId: string;
  provider: string;
  providerProductRef: string;
  displayName?: string;
}): Promise<Id<'product_catalog'>> {
  const now = Date.now();
  return await requireState().convex.insert('product_catalog', {
    authUserId: input.authUserId,
    productId: input.productId,
    provider: input.provider,
    providerProductRef: input.providerProductRef,
    displayName: input.displayName,
    status: 'active',
    supportsAutoDiscovery: false,
    createdAt: now,
    updatedAt: now,
  });
}
