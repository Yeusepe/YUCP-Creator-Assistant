import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT_DIR = resolve(import.meta.dir, '../..');
const COMPOSE_FILE = join(import.meta.dir, 'docker-compose.yml');
const PROJECT_NAME = process.env.CONVEX_REAL_BACKEND_PROJECT ?? 'yucp-convex-real';
const BACKEND_URL = process.env.CONVEX_REAL_BACKEND_URL ?? 'http://127.0.0.1:3210';
const SITE_URL = process.env.CONVEX_REAL_SITE_URL ?? 'http://127.0.0.1:3211';
const API_SECRET = 'test-convex-api-secret';
const INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-auth-secret';

const composeArgs = ['compose', '-p', PROJECT_NAME, '-f', COMPOSE_FILE];

type RunOptions = {
  env?: Record<string, string>;
  quiet?: boolean;
};

export function createComposeEnv(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value;
  }

  delete env.DATABASE_URL;
  delete env.POSTGRES_URL;
  delete env.MYSQL_URL;

  if (source.CONVEX_REAL_BACKEND_DATABASE_URL) {
    env.DATABASE_URL = source.CONVEX_REAL_BACKEND_DATABASE_URL;
  }
  if (source.CONVEX_REAL_BACKEND_POSTGRES_URL) {
    env.POSTGRES_URL = source.CONVEX_REAL_BACKEND_POSTGRES_URL;
  }
  if (source.CONVEX_REAL_BACKEND_MYSQL_URL) {
    env.MYSQL_URL = source.CONVEX_REAL_BACKEND_MYSQL_URL;
  }

  return env;
}

async function run(args: string[], options: RunOptions = {}): Promise<string> {
  const proc = Bun.spawn(args, {
    cwd: ROOT_DIR,
    env: options.env ?? process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (!options.quiet) {
    if (stdout.trim()) process.stdout.write(stdout);
    if (stderr.trim()) process.stderr.write(stderr);
  }
  if (exitCode !== 0) {
    throw new Error(`${args.join(' ')} failed with exit code ${exitCode}`);
  }
  return stdout;
}

async function waitForBackend(): Promise<void> {
  const deadline = Date.now() + 180_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BACKEND_URL}/version`);
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

function findCompleteBetterAuthPackage(): string | null {
  const bunModulesDir = join(ROOT_DIR, 'node_modules', '.bun');
  if (!existsSync(bunModulesDir)) return null;

  for (const entry of readdirSync(bunModulesDir)) {
    if (!entry.startsWith('@convex-dev+better-auth@')) continue;
    const candidate = join(
      bunModulesDir,
      entry,
      'node_modules',
      '@convex-dev',
      'better-auth'
    );
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

async function getAdminKey(): Promise<string> {
  const output = await run(
    ['docker', ...composeArgs, 'exec', '-T', 'backend', './generate_admin_key.sh'],
    { quiet: true }
  );
  const adminKey = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('convex-self-hosted|'));
  if (!adminKey) throw new Error('Convex self-hosted admin key was not generated');
  return adminKey;
}

function writeTestEnvFile(): string {
  const envFile = join(tmpdir(), 'yucp-convex-real-env.vars');
  writeFileSync(
    envFile,
    [
      `CONVEX_URL=${BACKEND_URL}`,
      `CONVEX_SITE_URL=${SITE_URL}`,
      'BETTER_AUTH_SECRET=test-better-auth-secret-for-convex-real-backend',
      'ENCRYPTION_SECRET=test-encryption-secret-for-convex-real-backend',
      'ACCOUNT_RECOVERY_CONTEXT_SECRET=test-account-recovery-secret-for-convex-real-backend',
      `INTERNAL_SERVICE_AUTH_SECRET=${INTERNAL_SERVICE_AUTH_SECRET}`,
      `CONVEX_API_SECRET=${API_SECRET}`,
      'VRCHAT_PROVIDER_SESSION_SECRET=test-vrchat-provider-session-secret',
      `BETTER_AUTH_URL=${SITE_URL}/api/auth`,
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

async function deploy(adminKey: string): Promise<void> {
  ensureBetterAuthResolvable();
  const env = {
    CONVEX_SELF_HOSTED_URL: BACKEND_URL,
    CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
  };
  await run(['bun', 'x', 'convex', 'env', 'set', '--from-file', writeTestEnvFile(), '--force'], {
    env: { ...process.env, ...env },
  });
  await run(
    ['bun', 'x', 'convex', 'deploy', '--yes', '--typecheck', 'disable', '--codegen', 'disable'],
    { env: { ...process.env, ...env } }
  );
}

async function up(): Promise<void> {
  await run(['docker', ...composeArgs, 'up', '-d'], { env: createComposeEnv() });
  await waitForBackend();
  await deploy(await getAdminKey());
}

async function down(): Promise<void> {
  await run(['docker', ...composeArgs, 'down', '-v'], { env: createComposeEnv() });
}

async function logs(): Promise<void> {
  await run(['docker', ...composeArgs, 'logs', '--no-color', '--tail=300'], {
    env: createComposeEnv(),
  });
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'up') return await up();
  if (command === 'down') return await down();
  if (command === 'logs') return await logs();
  throw new Error('Usage: bun run ops/convex-real/manage.ts <up|down|logs>');
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
