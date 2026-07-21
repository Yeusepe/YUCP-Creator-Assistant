import { afterAll, afterEach, beforeAll } from 'bun:test';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../../convex/_generated/api';
import type { Doc, Id, TableNames } from '../../../../../convex/_generated/dataModel';
import {
  API_SECRET,
  BACKEND_URL,
  INTERNAL_SERVICE_AUTH_SECRET,
  PROJECT_NAME,
  SITE_URL,
} from '../../../../../ops/convex-real/config';
import { type BuiltApiApp, buildApp } from '../../support/buildApp';

export const E2E_ENCRYPTION_SECRET = `e2e-${crypto.randomUUID()}`;
export const E2E_BETTER_AUTH_SECRET = 'test-better-auth-secret-32-chars!!';
export const E2E_UPLOAD_HMAC_KEY = 'test-upload-hmac-secret-32-chars!!';
export const E2E_INGEST_TUS_URL = 'https://ingest.e2e.invalid';

type HarnessState = {
  app: BuiltApiApp;
  componentClient: BetterAuthComponentClient;
  convex: RealConvex;
  server: ReturnType<typeof Bun.serve>;
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
  waitFor(
    predicate: () => Promise<boolean>,
    options: { timeoutMs?: number; intervalMs?: number; description: string }
  ): Promise<void>;
};

type RealConvexManageModule = {
  runSelfHostedConvexCli(args: string[], env: Record<string, string>): Promise<string>;
  selfHostedConvexEnv(adminKey: string): Record<string, string>;
  withSelfHostedConvexEnvFileMovedAside<T>(operation: () => Promise<T>): Promise<T>;
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
// ponytail: keep ops harness loading dynamic until its admin client type is exported cleanly.
const convexRealHarnessPath = ['..', '..', '..', '..', '..', 'ops', 'convex-real', 'harness'].join(
  '/'
);
const convexRealManagePath = ['..', '..', '..', '..', '..', 'ops', 'convex-real', 'manage'].join(
  '/'
);

async function loadRealConvexHarness(): Promise<RealConvexHarnessModule> {
  return (await import(convexRealHarnessPath)) as RealConvexHarnessModule;
}

async function loadRealConvexManage(): Promise<RealConvexManageModule> {
  return (await import(convexRealManagePath)) as RealConvexManageModule;
}

async function runConvexEnvSet(name: string, value: string): Promise<void> {
  const { getRealBackendAdminKey } = await loadRealConvexHarness();
  const { runSelfHostedConvexCli, selfHostedConvexEnv, withSelfHostedConvexEnvFileMovedAside } =
    await loadRealConvexManage();
  const env = selfHostedConvexEnv(await getRealBackendAdminKey());
  await withSelfHostedConvexEnvFileMovedAside(() =>
    runSelfHostedConvexCli(['env', 'set', name, value], env)
  );
}

async function getDockerNetworkGateway(): Promise<string | null> {
  const proc = Bun.spawn(
    [
      'docker',
      'network',
      'inspect',
      `${PROJECT_NAME}_default`,
      '--format',
      '{{range .IPAM.Config}}{{if .Gateway}}{{.Gateway}}{{end}}{{end}}',
    ],
    {
      stderr: 'pipe',
      stdout: 'pipe',
    }
  );
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    return null;
  }
  const gateway = stdout.trim();
  return gateway.length > 0 && gateway !== '<no value>' ? gateway : null;
}

async function getBackfillApiUrl(): Promise<string> {
  if (process.platform !== 'linux') {
    return 'http://host.docker.internal:3001';
  }
  const gateway = await getDockerNetworkGateway();
  if (!gateway) {
    throw new Error(`Could not resolve Docker gateway for ${PROJECT_NAME}_default`);
  }
  return `http://${gateway}:3001`;
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
    const backfillApiUrl = await getBackfillApiUrl();
    await runConvexEnvSet(
      'BACKFILL_API_URL',
      // Convex actions run in Docker, so they need the host's compose-network address.
      backfillApiUrl
    );
    await runConvexEnvSet('ENCRYPTION_SECRET', E2E_ENCRYPTION_SECRET);
    await runConvexEnvSet('BETTER_AUTH_SECRET', E2E_BETTER_AUTH_SECRET);
    const app = buildApp({
      baseUrl: 'http://127.0.0.1:3001',
      frontendUrl: 'http://127.0.0.1:3000',
      convexUrl: BACKEND_URL,
      convexSiteUrl: SITE_URL,
      convexApiSecret: API_SECRET,
      encryptionSecret: E2E_ENCRYPTION_SECRET,
      betterAuthSecret: E2E_BETTER_AUTH_SECRET,
      internalServiceAuthSecret: INTERNAL_SERVICE_AUTH_SECRET,
      internalRpcSharedSecret: `e2e-rpc-${crypto.randomUUID()}`,
      uploadHmacKey: E2E_UPLOAD_HMAC_KEY,
      ingestTusUrl: E2E_INGEST_TUS_URL,
    });
    const server = Bun.serve({
      hostname: '0.0.0.0',
      port: 3001,
      fetch: (request) => app.handle(request),
    });
    state = { app, componentClient, convex, server };
  });

  afterEach(async () => {
    await clearSeededState();
  });

  afterAll(async () => {
    try {
      await clearSeededState();
    } finally {
      state?.server.stop(true);
      state?.app.dispose();
      state = null;
    }
  });
}

export function getRealApiHarness(): HarnessState {
  return requireState();
}

export async function waitForRealBackend(
  predicate: () => Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; description: string }
): Promise<void> {
  const { waitFor } = await loadRealConvexHarness();
  await waitFor(predicate, options);
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

export async function createBetterAuthSession(authUserId: string): Promise<string> {
  const token = crypto.randomUUID();
  const now = Date.now();
  await callBetterAuthComponent('adapter:create', {
    input: {
      model: 'session',
      data: {
        token,
        userId: authUserId,
        expiresAt: now + 60 * 60 * 1000,
        createdAt: now,
        updatedAt: now,
      },
    },
    select: ['token'],
  });

  const signingKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(E2E_BETTER_AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', signingKey, new TextEncoder().encode(token));
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `${token}.${encodedSignature}`;
}

export async function createPublicApiKey(
  authUserId: string,
  scopes: string[],
  name = 'E2E public API key'
): Promise<string> {
  const created = await requireState().convex.mutation<{ key: string }>(
    api.betterAuthApiKeys.createApiKey,
    {
      apiSecret: API_SECRET,
      userId: authUserId,
      authUserId,
      name,
      scopes,
    }
  );
  return created.key;
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

export async function seedCreatorProfile(input: {
  authUserId: string;
  name?: string;
  ownerDiscordUserId?: string;
}): Promise<Id<'creator_profiles'>> {
  const now = Date.now();
  return await requireState().convex.insert('creator_profiles', {
    authUserId: input.authUserId,
    name: input.name ?? 'E2E Creator',
    ownerDiscordUserId: input.ownerDiscordUserId ?? `creator_${uniqueSuffix()}`,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
}

export async function seedProductCatalog(input: {
  authUserId: string;
  canonicalSlug?: string;
  productId: string;
  provider: string;
  providerProductRef: string;
  displayName?: string;
}): Promise<Id<'product_catalog'>> {
  const now = Date.now();
  return await requireState().convex.insert('product_catalog', {
    authUserId: input.authUserId,
    canonicalSlug: input.canonicalSlug,
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
