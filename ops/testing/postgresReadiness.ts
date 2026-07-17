export interface DockerCommandOutput {
  stdout: string;
  stderr: string;
}

export interface DockerCommandResult extends DockerCommandOutput {
  exitCode: number;
}

export interface WaitForPostgresOptions {
  containerName: string;
  databaseName: string;
  runDocker: (args: string[]) => Promise<DockerCommandOutput | DockerCommandResult>;
  sleep?: (delay: number) => Promise<void>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function executeDocker(
  runDocker: WaitForPostgresOptions['runDocker'],
  args: string[]
): Promise<DockerCommandResult> {
  try {
    const result = await runDocker(args);
    return {
      ...result,
      exitCode: 'exitCode' in result ? result.exitCode : 0,
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function waitForPostgres({
  containerName,
  databaseName,
  runDocker,
  sleep = delay,
}: WaitForPostgresOptions): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastResult: DockerCommandResult | undefined;
  let retryDelay = 100;

  while (Date.now() < deadline) {
    lastResult = await executeDocker(runDocker, [
      'exec',
      containerName,
      'psql',
      '--username',
      'postgres',
      '--dbname',
      databaseName,
      '--no-align',
      '--tuples-only',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      'SELECT 1',
    ]);
    if (lastResult.exitCode === 0 && lastResult.stdout.trim() === '1') {
      return;
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await sleep(Math.min(retryDelay, remaining));
      retryDelay = Math.min(retryDelay * 2, 1_000);
    }
  }

  const logs = await executeDocker(runDocker, ['logs', containerName]);
  throw new Error(
    `PostgreSQL did not accept queries within 60 seconds.\n${lastResult?.stderr ?? ''}\n${logs.stderr}\n${logs.stdout}`
  );
}
