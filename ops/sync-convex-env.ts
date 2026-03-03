/**
 * Syncs auth-related env vars from Infisical to Convex dev deployment.
 * Uses the Convex Deployment Platform API (update_environment_variables).
 * Run before dev:infisical so Convex has BETTER_AUTH_SECRET, DISCORD_* for auth.
 *
 * @see https://docs.convex.dev/deployment-api/update-environment-variables
 */

import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';

const CONVEX_ENV_VARS = [
  'BETTER_AUTH_SECRET',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
] as const;

async function main() {
  const secrets = await fetchInfisicalSecrets();
  if (Object.keys(secrets).length === 0) {
    console.warn('sync-convex-env: No secrets from Infisical, skipping');
    process.exit(0);
  }

  const convexUrl = secrets.CONVEX_URL ?? secrets.CONVEX_DEPLOYMENT_URL ?? process.env.CONVEX_URL;
  const deployKey =
    secrets.CONVEX_DEPLOY_KEY ?? secrets.CONVEX_API_SECRET ?? process.env.CONVEX_DEPLOY_KEY ?? process.env.CONVEX_API_SECRET;

  if (!convexUrl || !deployKey) {
    console.warn(
      'sync-convex-env: CONVEX_URL and CONVEX_DEPLOY_KEY (or CONVEX_API_SECRET) required in Infisical, skipping'
    );
    process.exit(0);
  }

  const changes: { name: string; value: string }[] = [];
  for (const name of CONVEX_ENV_VARS) {
    const value = secrets[name] ?? process.env[name];
    if (value) changes.push({ name, value });
  }

  if (changes.length === 0) {
    console.warn('sync-convex-env: No auth secrets to sync, skipping');
    process.exit(0);
  }

  const baseUrl = convexUrl.replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/api/v1/update_environment_variables`, {
    method: 'POST',
    headers: {
      Authorization: `Convex ${deployKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ changes }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('sync-convex-env: Convex API error', res.status, body);
    if (res.status === 401) {
      console.error(
        '  → Add CONVEX_DEPLOY_KEY to Infisical: Convex Dashboard → Settings → URL and deploy key (copy full string)'
      );
    }
    process.exit(1);
  }

  console.log(`sync-convex-env: Synced ${changes.length} vars to Convex`);
}

main().catch((err) => {
  console.error('sync-convex-env:', err);
  process.exit(1);
});
