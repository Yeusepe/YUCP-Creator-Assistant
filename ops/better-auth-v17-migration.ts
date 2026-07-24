import { resolve } from 'node:path';
import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';

type MigrationDeployment = 'dev' | 'prod';
type MigrationPhase = 'audit' | 'backfill' | 'cleanup';
type MigrationTable = 'account' | 'apikey';

export type BetterAuthV17MigrationOptions = {
  deployment: MigrationDeployment;
  phase: MigrationPhase;
  pageSize: number;
};

type MigrationBlocker = {
  recordId: string;
  code: string;
};

type MigrationPageResult = {
  table: MigrationTable;
  scanned: number;
  current: number;
  pendingBackfill: number;
  pendingCleanup: number;
  blockers: MigrationBlocker[];
  continueCursor: string;
  isDone: boolean;
  migrated?: number;
};

type MigrationTableAudit = {
  table: MigrationTable;
  scanned: number;
  current: number;
  pendingBackfill: number;
  pendingCleanup: number;
  blockerCount: number;
  blockers: MigrationBlocker[];
};

const PRODUCTION_CONFIRMATION = 'better-auth-v17';
const CLEANUP_CONFIRMATION = 'remove-legacy-auth-fields';
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 100;
const MAX_REPORTED_BLOCKERS = 100;
const USAGE = [
  'Better Auth 1.7 migration operator',
  '',
  'Audit development:',
  '  bun run migrate:better-auth:v17',
  '',
  'Audit production:',
  '  bun run migrate:better-auth:v17 -- --prod',
  '',
  'Backfill production:',
  '  bun run migrate:better-auth:v17 -- --prod --phase backfill --confirm-production=better-auth-v17',
  '',
  'Cleanup production:',
  '  bun run migrate:better-auth:v17 -- --prod --phase cleanup --confirm-production=better-auth-v17 --confirm-cleanup=remove-legacy-auth-fields',
].join('\n');

function readArgumentValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseBetterAuthV17MigrationOptions(args: string[]): BetterAuthV17MigrationOptions {
  let deployment: MigrationDeployment = 'dev';
  let phase: MigrationPhase = 'audit';
  let pageSize = DEFAULT_PAGE_SIZE;
  let productionConfirmation: string | undefined;
  let cleanupConfirmation: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === '--prod') {
      deployment = 'prod';
      continue;
    }
    if (argument === '--dev') {
      deployment = 'dev';
      continue;
    }
    if (argument === '--phase') {
      const value = readArgumentValue(args, index, '--phase');
      if (!['audit', 'backfill', 'cleanup'].includes(value)) {
        throw new Error(`Unsupported migration phase: ${value}`);
      }
      phase = value as MigrationPhase;
      index += 1;
      continue;
    }
    if (argument.startsWith('--phase=')) {
      const value = argument.slice('--phase='.length);
      if (!['audit', 'backfill', 'cleanup'].includes(value)) {
        throw new Error(`Unsupported migration phase: ${value}`);
      }
      phase = value as MigrationPhase;
      continue;
    }
    if (argument === '--page-size') {
      pageSize = Number(readArgumentValue(args, index, '--page-size'));
      index += 1;
      continue;
    }
    if (argument.startsWith('--page-size=')) {
      pageSize = Number(argument.slice('--page-size='.length));
      continue;
    }
    if (argument.startsWith('--confirm-production=')) {
      productionConfirmation = argument.slice('--confirm-production='.length);
      continue;
    }
    if (argument.startsWith('--confirm-cleanup=')) {
      cleanupConfirmation = argument.slice('--confirm-cleanup='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`Page size must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  if (
    deployment === 'prod' &&
    phase !== 'audit' &&
    productionConfirmation !== PRODUCTION_CONFIRMATION
  ) {
    throw new Error(
      `Production migration requires --confirm-production=${PRODUCTION_CONFIRMATION}`
    );
  }
  if (phase === 'cleanup' && cleanupConfirmation !== CLEANUP_CONFIRMATION) {
    throw new Error(`Cleanup requires --confirm-cleanup=${CLEANUP_CONFIRMATION}`);
  }

  return { deployment, phase, pageSize };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) {
      throw new Error('Convex migration command returned no JSON result');
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

async function buildConvexEnvironment(
  deployment: MigrationDeployment
): Promise<Record<string, string | undefined>> {
  const secrets = await fetchInfisicalSecrets({
    ...process.env,
    INFISICAL_ENV: deployment === 'prod' ? 'prod' : (process.env.INFISICAL_ENV ?? 'dev'),
  });
  const deployKey =
    deployment === 'prod'
      ? (secrets.CONVEX_DEPLOY_KEY_PROD ?? process.env.CONVEX_DEPLOY_KEY_PROD)
      : (secrets.CONVEX_DEPLOY_KEY ??
        secrets.CONVEX_API_SECRET ??
        process.env.CONVEX_DEPLOY_KEY ??
        process.env.CONVEX_API_SECRET);
  const deploymentName =
    deployment === 'prod'
      ? (secrets.CONVEX_DEPLOYMENT_PROD ?? process.env.CONVEX_DEPLOYMENT_PROD)
      : (secrets.CONVEX_DEPLOYMENT ?? process.env.CONVEX_DEPLOYMENT);

  if (deployment === 'prod' && !deployKey && !deploymentName) {
    throw new Error('Production Convex deployment credentials are unavailable');
  }

  return {
    ...process.env,
    ...secrets,
    CONVEX_DEPLOY_KEY: deployKey,
    CONVEX_DEPLOYMENT: deploymentName,
  };
}

async function runComponentFunction(
  env: Record<string, string | undefined>,
  deployment: MigrationDeployment,
  functionName: 'auditPage' | 'migratePage',
  args: Record<string, unknown>
): Promise<MigrationPageResult> {
  const command = [
    'bun',
    'x',
    'convex',
    'run',
    '--component',
    'betterAuth',
    `v17Migration:${functionName}`,
    JSON.stringify(args),
  ];
  if (deployment === 'prod') {
    command.push('--prod');
  }

  const child = Bun.spawn({
    cmd: command,
    cwd: resolve(import.meta.dir, '..'),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `Convex command failed with ${exitCode}`);
  }
  return extractJson(stdout) as MigrationPageResult;
}

async function auditTable(
  env: Record<string, string | undefined>,
  options: BetterAuthV17MigrationOptions,
  table: MigrationTable
): Promise<MigrationTableAudit> {
  let cursor: string | null = null;
  const summary: MigrationTableAudit = {
    table,
    scanned: 0,
    current: 0,
    pendingBackfill: 0,
    pendingCleanup: 0,
    blockerCount: 0,
    blockers: [],
  };

  for (;;) {
    const page = await runComponentFunction(env, options.deployment, 'auditPage', {
      table,
      cursor,
      limit: options.pageSize,
    });
    summary.scanned += page.scanned;
    summary.current += page.current;
    summary.pendingBackfill += page.pendingBackfill;
    summary.pendingCleanup += page.pendingCleanup;
    summary.blockerCount += page.blockers.length;
    summary.blockers.push(
      ...page.blockers.slice(0, Math.max(0, MAX_REPORTED_BLOCKERS - summary.blockers.length))
    );
    if (page.isDone) {
      return summary;
    }
    if (!page.continueCursor || page.continueCursor === cursor) {
      throw new Error(`Migration audit made no progress for ${table}`);
    }
    cursor = page.continueCursor;
  }
}

async function auditAll(
  env: Record<string, string | undefined>,
  options: BetterAuthV17MigrationOptions
): Promise<MigrationTableAudit[]> {
  return [await auditTable(env, options, 'account'), await auditTable(env, options, 'apikey')];
}

async function migrateTable(
  env: Record<string, string | undefined>,
  options: BetterAuthV17MigrationOptions,
  table: MigrationTable
): Promise<number> {
  if (options.phase === 'audit') {
    return 0;
  }
  let cursor: string | null = null;
  let migrated = 0;
  for (;;) {
    const page = await runComponentFunction(env, options.deployment, 'migratePage', {
      table,
      phase: options.phase,
      cursor,
      limit: options.pageSize,
    });
    migrated += page.migrated ?? 0;
    if (page.isDone) {
      return migrated;
    }
    if (!page.continueCursor || page.continueCursor === cursor) {
      throw new Error(`Migration mutation made no progress for ${table}`);
    }
    cursor = page.continueCursor;
  }
}

function total(audits: MigrationTableAudit[], field: keyof MigrationTableAudit): number {
  return audits.reduce((sum, audit) => {
    const value = audit[field];
    return sum + (typeof value === 'number' ? value : 0);
  }, 0);
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const options = parseBetterAuthV17MigrationOptions(process.argv.slice(2));
  const env = await buildConvexEnvironment(options.deployment);
  const before = await auditAll(env, options);
  if (total(before, 'blockerCount') > 0) {
    console.log(JSON.stringify({ options, before }, null, 2));
    throw new Error('Better Auth 1.7 migration audit found blockers');
  }
  if (options.phase === 'cleanup' && total(before, 'pendingBackfill') > 0) {
    console.log(JSON.stringify({ options, before }, null, 2));
    throw new Error('Better Auth 1.7 cleanup requires a completed production backfill');
  }

  const migrated =
    options.phase === 'audit'
      ? { account: 0, apikey: 0 }
      : {
          account: await migrateTable(env, options, 'account'),
          apikey: await migrateTable(env, options, 'apikey'),
        };
  const after = options.phase === 'audit' ? before : await auditAll(env, options);

  if (total(after, 'blockerCount') > 0 || total(after, 'pendingBackfill') > 0) {
    console.log(JSON.stringify({ options, before, migrated, after }, null, 2));
    throw new Error('Better Auth 1.7 migration did not reach a cutover-safe state');
  }
  if (options.phase === 'cleanup' && total(after, 'pendingCleanup') > 0) {
    console.log(JSON.stringify({ options, before, migrated, after }, null, 2));
    throw new Error('Better Auth 1.7 cleanup left legacy fields');
  }

  console.log(JSON.stringify({ options, before, migrated, after }, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
