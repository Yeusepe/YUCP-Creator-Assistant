import {
  ensureConvexDependenciesResolvable,
  ensureRealBackendUp,
  getRealBackendAdminKey,
  runSelfHostedConvexCli,
  selfHostedConvexEnv,
  withSelfHostedConvexEnvFileMovedAside,
} from './manage';
import {
  assertRequiredConvexDeploymentEnv,
  requiredConvexDeploymentEnvRequirements,
} from './preflight';

async function deploy(env: Record<string, string>): Promise<void> {
  await runSelfHostedConvexCli(['deploy', '-y'], env);
}

async function main(): Promise<void> {
  // This is intentionally a real deploy with Convex codegen and typecheck.
  // Test-only module loading flags and deploy bypass flags are not allowed.
  await withSelfHostedConvexEnvFileMovedAside(async () => {
    await ensureRealBackendUp();
    const env = selfHostedConvexEnv(await getRealBackendAdminKey());
    const requiredEnv = requiredConvexDeploymentEnvRequirements();
    await assertRequiredConvexDeploymentEnv(env, requiredEnv);
    console.log(
      `Convex deployment required-env preflight passed (${requiredEnv.map((names) => names.join(' or ')).join(', ')}).`
    );
    ensureConvexDependenciesResolvable();
    await deploy(env);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
