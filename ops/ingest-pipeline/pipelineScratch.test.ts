import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createPipelineScratchDirectory } from './pipelineScratch';

describe('pipeline scratch ownership', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await rm(root, { force: true, recursive: true });
      root = undefined;
    }
  });

  it('creates every job directory inside the reserved scratch root', async () => {
    root = await mkdtemp(join(tmpdir(), 'yucp-pipeline-scratch-test-'));

    const created = await createPipelineScratchDirectory({
      prefix: 'ingest-',
      root,
    });

    expect(resolve(dirname(created))).toBe(resolve(root));
    expect(relative(resolve(root), resolve(created))).not.toStartWith('..');
    expect(await readdir(root)).toEqual([created.slice(root.length + 1)]);
  });

  it('rejects a missing reserved scratch root', async () => {
    await expect(
      createPipelineScratchDirectory({
        prefix: 'promote-',
        root: ' ',
      })
    ).rejects.toThrow('reserved scratch root');
  });
});
