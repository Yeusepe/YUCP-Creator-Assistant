import { resolve } from 'node:path';
import {
  API_ACTOR_TTL_MS,
  type ApiActorBinding,
  createApiActorBinding,
  createServiceApiActor,
  isApiActorProtectedFunction,
} from '@yucp/shared/apiActor';
import { ConvexHttpClient } from 'convex/browser';
import {
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  getFunctionName,
  makeFunctionReference,
} from 'convex/server';
import type { Doc, Id, TableNames } from '../../convex/_generated/dataModel';
import { API_SECRET, BACKEND_URL, INTERNAL_SERVICE_AUTH_SECRET, PROJECT_NAME } from './config';

type AnyFunctionReference = FunctionReference<
  'query' | 'mutation' | 'action',
  'public' | 'internal',
  Record<string, unknown>,
  unknown,
  string | undefined
>;
type OptionalActorArgs<Args> = Args extends { actor: ApiActorBinding }
  ? Omit<Args, 'actor'> & { actor?: ApiActorBinding }
  : Args;
type OptionalActorRestArgs<FuncRef extends AnyFunctionReference> =
  keyof FunctionArgs<FuncRef> extends never
    ? [args?: OptionalActorArgs<FunctionArgs<FuncRef>>]
    : [args: OptionalActorArgs<FunctionArgs<FuncRef>>];

const COMPOSE_FILE = `${import.meta.dir}/docker-compose.yml`;
const ROOT_DIR = resolve(import.meta.dir, '../..');
const TEST_ACTOR_REFRESH_MARGIN_MS = 30_000;
const helper = {
  insert: makeFunctionReference<
    'mutation',
    { table: string; doc: Record<string, unknown> },
    string
  >('testHelpersReal:insert'),
  patch: makeFunctionReference<'mutation', { id: string; patch: Record<string, unknown> }, void>(
    'testHelpersReal:patch'
  ),
  deleteById: makeFunctionReference<'mutation', { id: string }, void>('testHelpersReal:deleteById'),
  get: makeFunctionReference<'query', { id: string }, unknown>('testHelpersReal:get'),
  collect: makeFunctionReference<'query', { table: string }, unknown[]>('testHelpersReal:collect'),
  clearAll: makeFunctionReference<'mutation', { includeScheduled?: boolean }, { deleted: number }>(
    'testHelpersReal:clearAll'
  ),
};

let adminKeyPromise: Promise<string> | null = null;
let testActorCache: { binding: ApiActorBinding; expiresAt: number } | null = null;

type RunOptions = {
  env?: Record<string, string>;
  timeoutMs?: number;
};

async function run(args: string[], options: RunOptions | number = {}): Promise<string> {
  const timeoutMs = typeof options === 'number' ? options : (options.timeoutMs ?? 60_000);
  let timedOut = false;
  const proc = Bun.spawn(args, {
    cwd: ROOT_DIR,
    env: typeof options === 'number' ? process.env : { ...process.env, ...options.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeoutId);

  if (timedOut) {
    throw new Error(`${args.join(' ')} timed out after ${timeoutMs}ms`);
  }
  if (exitCode !== 0) {
    throw new Error(`${args.join(' ')} failed with exit code ${exitCode}: ${stderr || stdout}`);
  }
  return stdout;
}

function describeFunctionReference(functionReference: unknown): string {
  try {
    return getFunctionName(functionReference as never);
  } catch {
    return typeof functionReference === 'string' ? functionReference : 'unknown';
  }
}

function mergeActorArg(args: unknown, actor: ApiActorBinding): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { actor };
  }
  if ('actor' in (args as Record<string, unknown>)) {
    return args;
  }
  return {
    ...(args as Record<string, unknown>),
    actor,
  };
}

function shouldAttachActor(functionReference: unknown, args: unknown): boolean {
  return (
    isApiActorProtectedFunction(describeFunctionReference(functionReference)) &&
    !!args &&
    typeof args === 'object' &&
    !Array.isArray(args) &&
    'apiSecret' in (args as Record<string, unknown>) &&
    !('actor' in (args as Record<string, unknown>))
  );
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .map(([key, entryValue]) => [key, stripUndefined(entryValue)]);
  return Object.fromEntries(entries);
}

export async function getRealBackendAdminKey(): Promise<string> {
  adminKeyPromise ??= (async () => {
    const output = await run(
      [
        'docker',
        'compose',
        '-p',
        PROJECT_NAME,
        '-f',
        COMPOSE_FILE,
        'exec',
        '-T',
        'backend',
        './generate_admin_key.sh',
      ],
      60_000
    );
    const adminKey = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith('convex-self-hosted|'));
    if (!adminKey) {
      throw new Error('Convex self-hosted admin key was not generated');
    }
    return adminKey;
  })();
  return await adminKeyPromise;
}

async function runConvexEnv(args: string[]): Promise<void> {
  await run(['bun', 'x', 'convex', 'env', ...args], {
    env: {
      CONVEX_SELF_HOSTED_URL: BACKEND_URL,
      CONVEX_SELF_HOSTED_ADMIN_KEY: await getRealBackendAdminKey(),
    },
    timeoutMs: 60_000,
  });
}

export async function removeRealBackendEnv(name: string): Promise<void> {
  await runConvexEnv(['remove', name]);
}

export async function restoreRealBackendTestSignal(): Promise<void> {
  await runConvexEnv(['set', 'IS_TEST', 'true']);
  await runConvexEnv(['set', 'YUCP_REAL_BACKEND_TEST_HELPERS', 'true']);
}

export function resetTestActorBindingCacheForTest(): void {
  testActorCache = null;
}

export async function getTestActorBindingForTest(now = Date.now()): Promise<ApiActorBinding> {
  return await getTestActorBinding(now);
}

async function getTestActorBinding(now = Date.now()): Promise<ApiActorBinding> {
  if (testActorCache && testActorCache.expiresAt - now > TEST_ACTOR_REFRESH_MARGIN_MS) {
    return testActorCache.binding;
  }

  const actor = createServiceApiActor({
    service: 'convex-real-test',
    scopes: [
      'creator:delegate',
      'downloads:service',
      'entitlements:service',
      'manual-licenses:service',
      'subjects:service',
      'verification-intents:service',
      'verification-sessions:service',
    ],
    now,
    ttlMs: API_ACTOR_TTL_MS,
  });
  const binding = await createApiActorBinding(actor, INTERNAL_SERVICE_AUTH_SECRET);
  testActorCache = { binding, expiresAt: actor.expiresAt };
  return binding;
}

export type RealConvex = Awaited<ReturnType<typeof makeRealConvex>>;

export async function makeRealConvex(options: { injectActor?: boolean } = {}) {
  const client = new ConvexHttpClient(BACKEND_URL, {
    skipConvexDeploymentUrlCheck: true,
  });
  client.setAdminAuth(await getRealBackendAdminKey());

  async function withActor<FuncRef extends AnyFunctionReference>(
    functionReference: FuncRef,
    args: OptionalActorArgs<FunctionArgs<FuncRef>> | undefined
  ): Promise<FunctionArgs<FuncRef>> {
    if (options.injectActor === false || !shouldAttachActor(functionReference, args)) {
      return args as FunctionArgs<FuncRef>;
    }
    return mergeActorArg(args, await getTestActorBinding()) as FunctionArgs<FuncRef>;
  }

  return {
    apiSecret: API_SECRET,
    query: async <FuncRef extends FunctionReference<'query'>>(
      functionReference: FuncRef,
      ...args: OptionalActorRestArgs<FuncRef>
    ): Promise<FunctionReturnType<FuncRef>> => {
      return await client.query(
        functionReference,
        await withActor(functionReference as never, args[0] as never)
      );
    },
    mutation: async <FuncRef extends FunctionReference<'mutation'>>(
      functionReference: FuncRef,
      ...args: OptionalActorRestArgs<FuncRef>
    ): Promise<FunctionReturnType<FuncRef>> => {
      return await client.mutation(
        functionReference,
        await withActor(functionReference as never, args[0] as never)
      );
    },
    action: async <FuncRef extends FunctionReference<'action'>>(
      functionReference: FuncRef,
      ...args: OptionalActorRestArgs<FuncRef>
    ): Promise<FunctionReturnType<FuncRef>> => {
      return await client.action(
        functionReference,
        await withActor(functionReference as never, args[0] as never)
      );
    },
    insert: async <Table extends TableNames>(
      table: Table,
      doc: Record<string, unknown>
    ): Promise<Id<Table>> => {
      return (await client.mutation(helper.insert, {
        table,
        doc: stripUndefined(doc) as Record<string, unknown>,
      })) as Id<Table>;
    },
    patch: async (id: string, patch: Record<string, unknown>): Promise<void> => {
      await client.mutation(helper.patch, {
        id,
        patch: stripUndefined(patch) as Record<string, unknown>,
      });
    },
    delete: async (id: string): Promise<void> => {
      await client.mutation(helper.deleteById, { id });
    },
    get: async <Table extends TableNames>(id: Id<Table>): Promise<Doc<Table> | null> => {
      return (await client.query(helper.get, { id })) as Doc<Table> | null;
    },
    collect: async <Table extends TableNames>(table: Table): Promise<Array<Doc<Table>>> => {
      return (await client.query(helper.collect, { table })) as Array<Doc<Table>>;
    },
    clearAll: async (): Promise<void> => {
      await client.mutation(helper.clearAll, { includeScheduled: true });
      while (true) {
        const result = await client.mutation(helper.clearAll, { includeScheduled: false });
        if (result.deleted === 0) return;
      }
    },
  };
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; description: string }
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${options.description}`);
}
