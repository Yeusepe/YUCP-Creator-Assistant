/**
 * Infisical → Convex runner.
 *
 * Works in two modes:
 *
 * 1. Sync mode (default — no extra args):
 *    Fetches all secrets from Infisical and sets them in the Convex deployment.
 *    Equivalent to `bun run sync:convex:env`.
 *
 *    bun run infisical:convex
 *    bun run infisical:convex --prod
 *
 * 2. Run mode (args after --):
 *    Fetches secrets from Infisical and injects them as env vars into any command,
 *    exactly like `infisical run --env=dev -- <cmd>`.
 *
 *    bun run infisical:convex -- bun x convex dev --once
 *    bun run infisical:convex --prod -- bun x convex deploy
 */

import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';
import { CONVEX_ENV_VARS } from './sync-convex-env';

const isProd = process.argv.includes('--prod');

// Bun strips `--` before passing args, so detect run mode by the presence of
// any non-flag argument (e.g. `bun run infisical:convex -- bun run publish`
// arrives as argv containing ["bun", "run", "publish"]).
const knownFlags = new Set(['--prod']);
const userArgs = process.argv.slice(2).filter((a) => !knownFlags.has(a));
const passthroughArgs = userArgs;
const isRunMode = passthroughArgs.length > 0;

async function getSecrets(): Promise<Record<string, string>> {
  const secrets = await fetchInfisicalSecrets();
  if (Object.keys(secrets).length === 0) {
    if (isProd) {
      console.error('infisical-convex-run: FATAL - No secrets returned from Infisical in production.');
      process.exit(1);
    }
    console.warn('infisical-convex-run: No secrets from Infisical, continuing with process env only');
  }
  return secrets;
}

async function runMode(secrets: Record<string, string>): Promise<void> {
  const [cmd, ...args] = passthroughArgs;
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...secrets,
  };

  console.log(`infisical-convex-run: injecting ${Object.keys(secrets).length} secrets → ${cmd} ${args.join(' ')}`);

  const proc = Bun.spawn({
    cmd: [cmd, ...args],
    env,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
}

async function syncMode(secrets: Record<string, string>): Promise<void> {
  // Re-use the same sync logic from sync-convex-env.ts inline so we don't double-fetch.
  const deployKey = isProd
    ? (secrets.CONVEX_DEPLOY_KEY_PROD ?? process.env.CONVEX_DEPLOY_KEY_PROD)
    : (secrets.CONVEX_DEPLOY_KEY ??
      secrets.CONVEX_API_SECRET ??
      process.env.CONVEX_DEPLOY_KEY ??
      process.env.CONVEX_API_SECRET);

  const deployment = isProd
    ? (secrets.CONVEX_DEPLOYMENT_PROD ?? process.env.CONVEX_DEPLOYMENT_PROD)
    : (secrets.CONVEX_DEPLOYMENT ?? process.env.CONVEX_DEPLOYMENT);

  if (!deployKey && !deployment) {
    console.warn(
      `infisical-convex-run: ${isProd ? 'CONVEX_DEPLOY_KEY_PROD' : 'CONVEX_DEPLOY_KEY'} not found, skipping Convex sync`
    );
    return;
  }

  const DEV_ENV_OVERRIDE_KEYS = new Set<string>(['FRONTEND_URL']);

  const changes: { name: string; value: string }[] = [];
  for (const name of CONVEX_ENV_VARS) {
    const envKey = name === 'BACKFILL_API_URL' && isProd ? 'BACKFILL_API_URL_PROD' : name;
    const localOverride = !isProd && DEV_ENV_OVERRIDE_KEYS.has(name) ? process.env[envKey] : undefined;
    const value = localOverride ?? secrets[envKey] ?? process.env[envKey];
    if (value) changes.push({ name, value });
  }

  if (changes.length === 0) {
    if (isProd) {
      console.error('infisical-convex-run: FATAL - No config secrets to sync in production.');
      process.exit(1);
    }
    console.warn('infisical-convex-run: No config secrets to sync, skipping');
    return;
  }

  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    CONVEX_DEPLOY_KEY: deployKey ?? process.env.CONVEX_DEPLOY_KEY,
    CONVEX_DEPLOYMENT: deployment ?? process.env.CONVEX_DEPLOYMENT,
  };

  const target = isProd ? 'prod' : 'dev';
  console.log(`infisical-convex-run: syncing ${changes.length} vars to Convex ${target}...`);

  for (const { name, value } of changes) {
    const args = ['convex', 'env', 'set', name, value];
    if (isProd) args.splice(2, 0, '--prod');

    const proc = Bun.spawn({
      cmd: ['bun', 'x', ...args],
      env: childEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      const details = [stdoutText.trim(), stderrText.trim()].filter(Boolean).join('\n');
      throw new Error(details || `convex env set ${name} failed with exit code ${exitCode}`);
    }
  }

  console.log(`infisical-convex-run: synced ${changes.length} vars to Convex ${target}`);
}

async function main(): Promise<void> {
  const secrets = await getSecrets();

  if (isRunMode) {
    await runMode(secrets);
  } else {
    await syncMode(secrets);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('infisical-convex-run:', err);
    process.exit(1);
  });
}
