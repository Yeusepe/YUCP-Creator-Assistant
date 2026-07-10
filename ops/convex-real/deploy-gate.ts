import { resolve } from 'node:path';
import {
  ensureConvexDependenciesResolvable,
  ensureRealBackendUp,
  getRealBackendAdminKey,
  selfHostedConvexEnv,
} from './manage';
import { assertRequiredConvexDeploymentEnv, requiredConvexDeploymentEnv } from './preflight';

const ROOT_DIR = resolve(import.meta.dir, '../..');

async function deploy(env: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(['bun', 'x', 'convex', 'deploy', '-y', '--typecheck', 'disable'], {
    cwd: ROOT_DIR,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`bun x convex deploy -y failed with exit code ${exitCode}`);
  }
}

async function main(): Promise<void> {
  // This is intentionally a real deploy: no test-only module loading flags,
  // deploy --dry-run, or codegen disable flags are allowed. The repo's Convex
  // TypeScript suite is an independent CI gate; the self-hosted component's
  // generated bindings are not compatible with the source typecheck contract.
  await ensureRealBackendUp();
  const env = selfHostedConvexEnv(await getRealBackendAdminKey());
  const requiredEnv = requiredConvexDeploymentEnv();
  await assertRequiredConvexDeploymentEnv(env, requiredEnv);
  console.log(`Convex deployment required-env preflight passed (${requiredEnv.join(', ')}).`);
  ensureConvexDependenciesResolvable();
  await deploy(env);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
