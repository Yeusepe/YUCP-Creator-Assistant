async function run(args: string[]): Promise<number> {
  const proc = Bun.spawn(args, {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
}

let exitCode = await run(['bun', 'run', 'test:convex:real:up']);

for (const command of [
  ['bun', 'run', 'test:convex:deploy'],
  ['bun', 'run', 'ops/convex-real/manage.ts', 'test-signals'],
  ['bun', 'run', 'test:e2e:flows:run'],
]) {
  if (exitCode !== 0) break;
  exitCode = await run(command);
}

const teardownExit = await run(['bun', 'run', 'test:convex:real:down']);
process.exit(exitCode === 0 ? teardownExit : exitCode);

export {};
