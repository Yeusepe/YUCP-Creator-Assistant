import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  API_SECRET,
  BACKEND_URL,
  BETTER_AUTH_SECRET,
  ENCRYPTION_SECRET,
  INTERNAL_SERVICE_AUTH_SECRET,
  PROJECT_NAME,
  SITE_URL,
} from './config';

const ROOT_DIR = resolve(import.meta.dir, '../..');
const COMPOSE_FILE = join(import.meta.dir, 'docker-compose.yml');
const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
const BACKEND_FETCH_TIMEOUT_MS = 10_000;
const FORCE_KILL_GRACE_MS = 5_000;
const ENV_ISOLATION_LOCK_TIMEOUT_MS = 300_000;
const ENV_ISOLATION_STALE_MS = 600_000;

export interface SelfHostedConvexProfile {
  backendPort: number;
  dashboardPort: number;
  projectName: string;
  sitePort: number;
}

const DEFAULT_PROFILE: SelfHostedConvexProfile = {
  backendPort: Number(new URL(BACKEND_URL).port),
  dashboardPort: 6791,
  projectName: PROJECT_NAME,
  sitePort: Number(new URL(SITE_URL).port),
};

function resolveProfile(profile: SelfHostedConvexProfile = DEFAULT_PROFILE) {
  return {
    ...profile,
    backendUrl: `http://127.0.0.1:${profile.backendPort}`,
    siteUrl: `http://127.0.0.1:${profile.sitePort}`,
  };
}

function composeArgs(profile: SelfHostedConvexProfile): string[] {
  return ['compose', '-p', profile.projectName, '-f', COMPOSE_FILE];
}

function composeEnvironment(profile: SelfHostedConvexProfile): Record<string, string> {
  return {
    ...process.env,
    CONVEX_CLOUD_ORIGIN: `http://127.0.0.1:${profile.backendPort}`,
    CONVEX_SITE_ORIGIN: `http://127.0.0.1:${profile.sitePort}`,
    DASHBOARD_PORT: String(profile.dashboardPort),
    NEXT_PUBLIC_DEPLOYMENT_URL: `http://127.0.0.1:${profile.backendPort}`,
    PORT: String(profile.backendPort),
    SITE_PROXY_PORT: String(profile.sitePort),
  } as Record<string, string>;
}

type RunOptions = {
  env?: Record<string, string>;
  quiet?: boolean;
  timeoutMs?: number;
};

async function run(args: string[], options: RunOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  let timedOut = false;
  const proc = Bun.spawn(args, {
    cwd: ROOT_DIR,
    env: options.env ?? process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
    setTimeout(() => proc.kill('SIGKILL'), FORCE_KILL_GRACE_MS).unref();
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeoutId);
  if (!options.quiet) {
    if (stdout.trim()) process.stdout.write(stdout);
    if (stderr.trim()) process.stderr.write(stderr);
  }
  if (timedOut) {
    throw new Error(`${args.join(' ')} timed out after ${timeoutMs}ms and was killed`);
  }
  if (exitCode !== 0) {
    throw new Error(`${args.join(' ')} failed with exit code ${exitCode}`);
  }
  return stdout;
}

/**
 * Runs a Convex CLI command against the self-hosted backend only. Callers must
 * provide `selfHostedConvexEnv()` so cloud deployment selection cannot leak in.
 */
export async function runSelfHostedConvexCli(
  args: string[],
  env: Record<string, string>,
  options: Omit<RunOptions, 'env'> = {}
): Promise<string> {
  return await run(['bun', 'x', 'convex', ...args], { ...options, env });
}

async function waitForBackend(profile: SelfHostedConvexProfile = DEFAULT_PROFILE): Promise<void> {
  const { backendUrl } = resolveProfile(profile);
  const deadline = Date.now() + 180_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${backendUrl}/version`, {
        signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        console.log(`Convex backend healthy: ${await response.text()}`);
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(2_000);
  }
  throw new Error(`Convex backend did not become healthy: ${String(lastError)}`);
}

async function pullImagesWithRetry(
  profile: SelfHostedConvexProfile = DEFAULT_PROFILE
): Promise<void> {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await run(['docker', ...composeArgs(profile), 'pull'], {
        env: composeEnvironment(profile),
        timeoutMs: 300_000,
      });
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      console.warn(`Docker image pull failed on attempt ${attempt}; retrying.`);
      await Bun.sleep(5_000 * attempt);
    }
  }
}

function findCompleteBetterAuthPackage(): string | null {
  const bunModulesDir = join(ROOT_DIR, 'node_modules', '.bun');
  if (!existsSync(bunModulesDir)) return null;

  for (const entry of readdirSync(bunModulesDir)) {
    if (!entry.startsWith('@convex-dev+better-auth@')) continue;
    const candidate = join(bunModulesDir, entry, 'node_modules', '@convex-dev', 'better-auth');
    if (existsSync(join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  return null;
}

function ensureBetterAuthResolvable(): void {
  const packagePath = join(ROOT_DIR, 'node_modules', '@convex-dev', 'better-auth');
  if (existsSync(join(packagePath, 'package.json'))) return;

  const target = findCompleteBetterAuthPackage();
  if (!target) {
    throw new Error('@convex-dev/better-auth is not installed with package.json');
  }

  for (const link of [
    packagePath,
    join(ROOT_DIR, 'node_modules', '.bun', 'node_modules', '@convex-dev', 'better-auth'),
  ]) {
    mkdirSync(dirname(link), { recursive: true });
    if (existsSync(link)) rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

export async function getRealBackendAdminKey(
  profile: SelfHostedConvexProfile = DEFAULT_PROFILE
): Promise<string> {
  const output = await run(
    ['docker', ...composeArgs(profile), 'exec', '-T', 'backend', './generate_admin_key.sh'],
    { env: composeEnvironment(profile), quiet: true }
  );
  const adminKey = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('convex-self-hosted|'));
  if (!adminKey) throw new Error('Convex self-hosted admin key was not generated');
  return adminKey;
}

/**
 * Builds the single test deployment env file used by both the real suite and
 * the deploy gate. Keep this list here so every self-hosted path provisions
 * exactly the same deployment contract.
 */
export function writeRealBackendEnvFile(
  profile: SelfHostedConvexProfile = DEFAULT_PROFILE,
  options: {
    betterAuthAdditionalTrustedOrigins?: readonly string[];
  } = {}
): string {
  const resolved = resolveProfile(profile);
  const additionalTrustedOrigins = options.betterAuthAdditionalTrustedOrigins ?? [];
  if (
    additionalTrustedOrigins.length > 16 ||
    additionalTrustedOrigins.some((origin) => {
      try {
        const parsed = new URL(origin);
        return (
          parsed.origin !== origin ||
          !['http:', 'https:'].includes(parsed.protocol) ||
          Boolean(
            parsed.username ||
              parsed.password ||
              parsed.pathname !== '/' ||
              parsed.search ||
              parsed.hash
          )
        );
      } catch {
        return true;
      }
    }) ||
    new Set(additionalTrustedOrigins).size !== additionalTrustedOrigins.length
  ) {
    throw new Error('The additional Better Auth origins are invalid');
  }
  const envFile = join(tmpdir(), `yucp-convex-real-env-${profile.projectName}.vars`);
  writeFileSync(
    envFile,
    [
      `CONVEX_URL=${resolved.backendUrl}`,
      `CONVEX_SITE_URL=${resolved.siteUrl}`,
      `BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}`,
      `BETTER_AUTH_ADDITIONAL_TRUSTED_ORIGINS_JSON=${JSON.stringify(additionalTrustedOrigins)}`,
      `ENCRYPTION_SECRET=${ENCRYPTION_SECRET}`,
      'ACCOUNT_RECOVERY_CONTEXT_SECRET=test-account-recovery-secret-for-convex-real-backend',
      `INTERNAL_SERVICE_AUTH_SECRET=${INTERNAL_SERVICE_AUTH_SECRET}`,
      `CONVEX_API_SECRET=${API_SECRET}`,
      'VRCHAT_PROVIDER_SESSION_SECRET=test-vrchat-provider-session-secret',
      `BETTER_AUTH_URL=${resolved.siteUrl}/api/auth`,
      'API_BASE_URL=http://127.0.0.1:3001',
      'DISCORD_CLIENT_ID=000000000000000000',
      'DISCORD_CLIENT_SECRET=test-discord-client-secret',
      'ROLE_SYNC_VIA_WORKPOOL=false',
      'DISCORD_BOT_TOKEN=test-discord-bot-token',
      'FRONTEND_URL=http://127.0.0.1:3000',
      'SITE_URL=http://127.0.0.1:3000',
      'BACKFILL_API_URL=http://127.0.0.1:3001',
      'YUCP_ROOT_PRIVATE_KEY=test-yucp-root-private-key',
      'YUCP_ROOT_KEY_ID=test-yucp-root-key-id',
      'YUCP_KEY_ID=test-yucp-key-id',
      'YUCP_TRUST_BUNDLE_JSON={"keys":[]}',
      'POLAR_ACCESS_TOKEN=test-polar-access-token',
      'POLAR_WEBHOOK_SECRET=test-polar-webhook-secret',
      'POLAR_SERVER=sandbox',
      'YUCP_BROKER_SHARED_SECRET=test-yucp-broker-shared-secret',
      'YUCP_GRANT_SEAL_KEY=test-yucp-grant-seal-key',
      'YUCP_COUPLING_HMAC_KEY=test-yucp-coupling-hmac-key',
      'YUCP_RELEASE_ENVELOPE_KEY=test-yucp-release-envelope-key',
      '',
    ].join('\n')
  );
  return envFile;
}

export function selfHostedConvexEnv(
  adminKey: string,
  profile: SelfHostedConvexProfile = DEFAULT_PROFILE
): Record<string, string> {
  const resolved = resolveProfile(profile);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }

  // Bun loads .env.local before this script. A configured cloud deployment or
  // deploy key must never win over the self-hosted backend used by this harness.
  delete env.CONVEX_DEPLOYMENT;
  delete env.CONVEX_DEPLOYMENT_PROD;
  delete env.CONVEX_DEPLOY_KEY;
  delete env.CONVEX_DEPLOY_KEY_PROD;

  return {
    ...env,
    CONVEX_SELF_HOSTED_URL: resolved.backendUrl,
    CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
  };
}

/**
 * Bun loads `.env` and `.env.local` itself, after inheriting the process env.
 * Move both aside around every self-hosted CLI sequence so local cloud
 * `CONVEX_DEPLOYMENT` selectors can never select Convex Cloud. The original
 * files are restored even when a command fails.
 */
async function withSelfHostedConvexEnvFileMovedAsideUnlocked<T>(
  operation: () => Promise<T>,
  envDirectory: string
): Promise<T> {
  const movedEnvFiles = ['.env', '.env.local']
    .map((name) => join(envDirectory, name))
    .filter((envFilePath) => existsSync(envFilePath))
    .map((envFilePath) => ({
      envFilePath,
      backupPath: `${envFilePath}.convex-real-backup-${process.pid}-${Date.now()}`,
    }));

  if (movedEnvFiles.length === 0) return await operation();

  const restoreOriginalEnvFiles = (): void => {
    const restorationErrors: unknown[] = [];
    for (const { envFilePath, backupPath } of [...movedEnvFiles].reverse()) {
      try {
        if (existsSync(envFilePath)) {
          const unexpectedPath = `${backupPath}.unexpected`;
          renameSync(envFilePath, unexpectedPath);
          renameSync(backupPath, envFilePath);
          throw new Error(
            `Self-hosted Convex command recreated ${envFilePath}; original restored and unexpected file moved to ${unexpectedPath}`
          );
        }
        renameSync(backupPath, envFilePath);
      } catch (error) {
        restorationErrors.push(error);
      }
    }

    if (restorationErrors.length === 1) throw restorationErrors[0];
    if (restorationErrors.length > 1) {
      throw new AggregateError(restorationErrors, 'Failed to restore self-hosted Convex env files');
    }
  };

  try {
    for (const { envFilePath, backupPath } of movedEnvFiles) {
      renameSync(envFilePath, backupPath);
    }
  } catch (error) {
    try {
      restoreOriginalEnvFiles();
    } catch (restorationError) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AggregateError([error, restorationError], message);
    }
    throw error;
  }

  let operationFailed = false;
  let operationError: unknown;
  let result: T | undefined;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let restorationFailed = false;
  let restorationError: unknown;
  try {
    restoreOriginalEnvFiles();
  } catch (error) {
    restorationFailed = true;
    restorationError = error;
  }

  if (operationFailed) {
    if (restorationFailed) {
      const message =
        operationError instanceof Error ? operationError.message : String(operationError);
      throw new AggregateError([operationError, restorationError], message);
    }
    throw operationError;
  }
  if (restorationFailed) throw restorationError;
  return result as T;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireEnvIsolationLock(envDirectory: string): Promise<() => Promise<void>> {
  const lockPath = join(envDirectory, '.convex-self-hosted-env.lock');
  const nonce = randomUUID();
  const deadline = Date.now() + ENV_ISOLATION_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ nonce, pid: process.pid })}\n`, 'utf8');
      await handle.sync();
      return async () => {
        await handle.close();
        const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { nonce?: unknown };
        if (lock.nonce !== nonce) {
          throw new Error('Self-hosted Convex environment lock ownership changed');
        }
        await rm(lockPath);
      };
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
        throw error;
      }
      let removeStaleLock = false;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > ENV_ISOLATION_STALE_MS) {
          removeStaleLock = true;
        } else {
          const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown };
          removeStaleLock = typeof lock.pid === 'number' && !processExists(lock.pid);
        }
      } catch {
        removeStaleLock = false;
      }
      if (removeStaleLock) {
        await rm(lockPath, { force: true });
        continue;
      }
      await Bun.sleep(50);
    }
  }
  throw new Error('Timed out waiting for the self-hosted Convex environment lock');
}

export async function withSelfHostedConvexEnvFileMovedAside<T>(
  operation: () => Promise<T>,
  envDirectory = ROOT_DIR
): Promise<T> {
  const release = await acquireEnvIsolationLock(envDirectory);
  try {
    return await withSelfHostedConvexEnvFileMovedAsideUnlocked(operation, envDirectory);
  } finally {
    await release();
  }
}

export async function provisionRealBackendEnv(
  adminKey: string,
  profile: SelfHostedConvexProfile = DEFAULT_PROFILE,
  options: {
    betterAuthAdditionalTrustedOrigins?: readonly string[];
  } = {}
): Promise<void> {
  await withSelfHostedConvexEnvFileMovedAside(() =>
    runSelfHostedConvexCli(
      ['env', 'set', '--from-file', writeRealBackendEnvFile(profile, options), '--force'],
      selfHostedConvexEnv(adminKey, profile)
    )
  );
}

export async function enableRealBackendTestHelpers(
  adminKey: string,
  profile: SelfHostedConvexProfile = DEFAULT_PROFILE
): Promise<void> {
  const env = selfHostedConvexEnv(adminKey, profile);
  await withSelfHostedConvexEnvFileMovedAside(async () => {
    await runSelfHostedConvexCli(['env', 'set', 'IS_TEST', 'true'], env);
    await runSelfHostedConvexCli(['env', 'set', 'YUCP_REAL_BACKEND_TEST_HELPERS', 'true'], env);
  });
}

export function ensureConvexDependenciesResolvable(): void {
  ensureBetterAuthResolvable();
}

export async function up(
  profile: SelfHostedConvexProfile = DEFAULT_PROFILE,
  options: {
    betterAuthAdditionalTrustedOrigins?: readonly string[];
  } = {}
): Promise<void> {
  await pullImagesWithRetry(profile);
  await run(['docker', ...composeArgs(profile), 'up', '-d'], {
    env: composeEnvironment(profile),
  });
  await waitForBackend(profile);
  await provisionRealBackendEnv(await getRealBackendAdminKey(profile), profile, options);
}

export async function isRealBackendHealthy(
  profile: SelfHostedConvexProfile = DEFAULT_PROFILE
): Promise<boolean> {
  const { backendUrl } = resolveProfile(profile);
  try {
    return (
      await fetch(`${backendUrl}/version`, {
        signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
      })
    ).ok;
  } catch {
    return false;
  }
}

export async function ensureRealBackendUp(
  profile: SelfHostedConvexProfile = DEFAULT_PROFILE,
  options: {
    betterAuthAdditionalTrustedOrigins?: readonly string[];
  } = {}
): Promise<void> {
  if (await isRealBackendHealthy(profile)) {
    await provisionRealBackendEnv(await getRealBackendAdminKey(profile), profile, options);
    return;
  }
  await up(profile, options);
}

export async function stopRealBackend(
  profile: SelfHostedConvexProfile = DEFAULT_PROFILE
): Promise<void> {
  await run(['docker', ...composeArgs(profile), 'down', '-v'], {
    env: composeEnvironment(profile),
  });
}

async function logs(): Promise<void> {
  await run(['docker', ...composeArgs(DEFAULT_PROFILE), 'logs', '--no-color', '--tail=300']);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'up') return await up();
  if (command === 'test-signals')
    return await enableRealBackendTestHelpers(await getRealBackendAdminKey());
  if (command === 'down') return await stopRealBackend();
  if (command === 'logs') return await logs();
  throw new Error('Usage: bun run ops/convex-real/manage.ts <up|test-signals|down|logs>');
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
