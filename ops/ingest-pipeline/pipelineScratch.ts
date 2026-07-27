import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

export async function createPipelineScratchDirectory(input: {
  prefix: string;
  root: string;
}): Promise<string> {
  const configuredRoot = input.root.trim();
  if (!configuredRoot) {
    throw new Error('Pipeline requires a reserved scratch root');
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(input.prefix)) {
    throw new Error('Pipeline scratch prefix is invalid');
  }

  const resolvedRoot = resolve(configuredRoot);
  await mkdir(resolvedRoot, { recursive: true });
  const canonicalRoot = await realpath(resolvedRoot);
  const created = await mkdtemp(join(canonicalRoot, input.prefix));
  const child = relative(canonicalRoot, created);
  if (
    !child ||
    child === '..' ||
    child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error('Pipeline scratch directory escaped its reserved root');
  }
  return created;
}
