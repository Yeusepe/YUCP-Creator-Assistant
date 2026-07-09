async function run(args: string[]): Promise<number> {
  const proc = Bun.spawn(args, {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
}

let exitCode = await run(['bun', 'run', 'test:convex:real:up']);

if (exitCode === 0) {
  exitCode = await run(['bun', 'run', 'test:e2e:flows:run']);
}

const teardownExit = await run(['bun', 'run', 'test:convex:real:down']);
process.exit(exitCode === 0 ? teardownExit : exitCode);

export {};
