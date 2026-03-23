/**
 * Syncs auth-related env vars from Infisical to Convex deployment.
 * Uses the Convex CLI so it works with either local `convex login`
 * or non-interactive `CONVEX_DEPLOY_KEY` in CI/remote environments.
 *
 * Usage:
 *   bun run sync:convex:env          → sync to dev
 *   bun run sync:convex:env --prod   → sync to prod
 */

import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';

const CONVEX_ENV_VARS = [
  'BETTER_AUTH_SECRET',
  'ENCRYPTION_SECRET',
  'INTERNAL_SERVICE_AUTH_SECRET',
  'VRCHAT_PROVIDER_SESSION_SECRET',
  'BETTER_AUTH_URL',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'FRONTEND_URL',
  'SITE_URL',
  'BACKFILL_API_URL',
  'YUCP_ROOT_PRIVATE_KEY',
  'YUCP_KEY_ID',
  'POLAR_ACCESS_TOKEN',
  'POLAR_WEBHOOK_SECRET',
  'POLAR_CERT_PRODUCTS_JSON',
  'POLAR_SERVER',
] as const;

const DEV_ENV_OVERRIDE_KEYS = new Set<(typeof CONVEX_ENV_VARS)[number]>(['FRONTEND_URL']);

const isProd = process.argv.includes('--prod');

async function runConvexEnvSet(
  name: string,
  value: string,
  env: Record<string, string | undefined>
): Promise<void> {
  const args = ['convex', 'env', 'set', name, value];
  if (isProd) {
    args.splice(2, 0, '--prod');
  }

  const proc = Bun.spawn({
    cmd: ['bun', 'x', ...args],
    env,
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

async function main() {
  const secrets = await fetchInfisicalSecrets();
  if (Object.keys(secrets).length === 0) {
    if (isProd) {
      console.error(
        'sync-convex-env: FATAL - No secrets returned from Infisical in production. Refusing to deploy with potentially stale/missing secrets.'
      );
      process.exit(1);
    }
    console.warn('sync-convex-env: No secrets from Infisical, skipping');
    process.exit(0);
  }

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
      `sync-convex-env: ${isProd ? 'CONVEX_DEPLOY_KEY_PROD' : 'CONVEX_DEPLOY_KEY'} or local convex login required, skipping`
    );
    process.exit(0);
  }

  const changes: { name: string; value: string }[] = [];
  for (const name of CONVEX_ENV_VARS) {
    const envKey = name === 'BACKFILL_API_URL' && isProd ? 'BACKFILL_API_URL_PROD' : name;
    const localOverride =
      !isProd && DEV_ENV_OVERRIDE_KEYS.has(name) ? process.env[envKey] : undefined;
    const value = localOverride ?? secrets[envKey] ?? process.env[envKey];
    if (value) changes.push({ name, value });
  }

  if (changes.length === 0) {
    if (isProd) {
      console.error('sync-convex-env: FATAL - No config secrets to sync in production.');
      process.exit(1);
    }
    console.warn('sync-convex-env: No config secrets to sync, skipping');
    process.exit(0);
  }

  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    CONVEX_DEPLOY_KEY: deployKey ?? process.env.CONVEX_DEPLOY_KEY,
    CONVEX_DEPLOYMENT: deployment ?? process.env.CONVEX_DEPLOYMENT,
  };

  for (const change of changes) {
    await runConvexEnvSet(change.name, change.value, childEnv);
  }

  console.log(
    `sync-convex-env: Synced ${changes.length} vars to Convex ${isProd ? 'prod' : 'dev'}`
  );
}

main().catch((err) => {
  console.error('sync-convex-env:', err);
  process.exit(1);
});
