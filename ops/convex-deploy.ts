const UNITY_CLIENT_SEED = 'seedYucpOAuthClient:seedUnityOAuthClient';

async function runConvex(args: string[]): Promise<void> {
  const child = Bun.spawn(['bun', ...args], {
    cwd: process.cwd(),
    env: process.env,
    stderr: 'inherit',
    stdin: 'inherit',
    stdout: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Convex command failed with exit code ${exitCode}`);
  }
}

export async function deployConvex(
  deployArguments: readonly string[] = process.argv.slice(2)
): Promise<void> {
  await runConvex(['x', 'convex', 'deploy', ...deployArguments]);
  if (deployArguments.includes('--dry-run')) {
    return;
  }
  await runConvex(['x', 'convex', 'run', UNITY_CLIENT_SEED, '{}', '--prod']);
}

if (import.meta.main) {
  try {
    await deployConvex();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'The Convex deployment failed'
    );
    process.exit(1);
  }
}
