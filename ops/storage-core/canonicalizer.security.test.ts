import { afterAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { canonicalizeArtifact } from './canonicalizer';
import { runCommand } from './process';

const scratchPaths: string[] = [];

function assertScratchPath(scratchPath: string): void {
  const scratchRelativePath = relative(resolve(tmpdir()), resolve(scratchPath));
  if (
    !scratchRelativePath ||
    scratchRelativePath === '..' ||
    scratchRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(
      `Refusing to clean scratch path outside the system temp directory: ${scratchPath}`
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function expectNoCanonicalizerScratch(scratchPath: string): Promise<void> {
  expect(
    (await readdir(scratchPath)).filter((entry) => entry.startsWith('.canonicalize-'))
  ).toEqual([]);
}

afterAll(async () => {
  for (const scratchPath of scratchPaths) {
    assertScratchPath(scratchPath);
    await rm(scratchPath, { force: true, recursive: true });
  }
});

describe('canonicalizer decompression budget', () => {
  it('rejects a small ZIP that expands beyond the byte budget', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-canonicalizer-zip-budget-'));
    scratchPaths.push(scratchPath);
    const inputPath = join(scratchPath, 'bomb.zip');
    const outputPath = join(scratchPath, 'canonical.zip');
    const maxDecompressedBytes = 8 * 1024;
    await writeFile(
      inputPath,
      zipSync({ 'payload.txt': [Buffer.alloc(128 * 1024, 'z'), { level: 9 }] })
    );

    expect((await stat(inputPath)).size).toBeLessThan(maxDecompressedBytes);
    await expect(
      canonicalizeArtifact({ inputPath, outputPath, maxDecompressedBytes })
    ).rejects.toThrow('decompressed byte budget');
    expect(await pathExists(outputPath)).toBeFalse();
    await expectNoCanonicalizerScratch(scratchPath);
  });

  it('rejects a small tar.gz before extracting a tar beyond the byte budget', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-canonicalizer-targz-budget-'));
    scratchPaths.push(scratchPath);
    const sourcePath = join(scratchPath, 'source');
    const tarPath = join(scratchPath, 'bomb.tar');
    const inputPath = join(scratchPath, 'bomb.tar.gz');
    const outputPath = join(scratchPath, 'canonical.tar.gz');
    const maxDecompressedBytes = 16 * 1024;
    await mkdir(sourcePath);
    await writeFile(join(sourcePath, 'payload.txt'), Buffer.alloc(128 * 1024, 't'));
    await runCommand('tar', [
      '--force-local',
      '--create',
      '--file',
      tarPath,
      '--format=gnu',
      '--directory',
      sourcePath,
      '.',
    ]);
    await runCommand('gzip', ['--stdout', '--', tarPath], { stdoutPath: inputPath });
    await rm(tarPath, { force: true });

    expect((await stat(inputPath)).size).toBeLessThan(maxDecompressedBytes);
    await expect(
      canonicalizeArtifact({ inputPath, outputPath, maxDecompressedBytes })
    ).rejects.toThrow('decompressed byte budget');
    expect(await pathExists(outputPath)).toBeFalse();
    await expectNoCanonicalizerScratch(scratchPath);
  });
});
