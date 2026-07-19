import { afterAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { types as tarTypes } from 'tar';
import { canonicalizeArtifact, canonicalizerChildEnv } from './canonicalizer';
import { runCommand } from './process';

const scratchPaths: string[] = [];

type TarEntry = {
  body?: Buffer;
  linkName?: string;
  name: string;
  type: '\0' | '0' | '2' | '6';
};

const ARCHIVE_ENTRY_LIMIT = 100_000;

function writeTarText(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength > length) {
    throw new Error(`Tar fixture field is too long: ${value}`);
  }
  bytes.copy(header, offset);
}

function tarOctal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function tarHeader(entry: TarEntry): Buffer {
  const bodyLength = entry.body?.byteLength ?? 0;
  const header = Buffer.alloc(512);
  writeTarText(header, 0, 100, entry.name);
  writeTarText(header, 100, 8, tarOctal(entry.type === '2' ? 0o777 : 0o644, 8));
  writeTarText(header, 108, 8, tarOctal(0, 8));
  writeTarText(header, 116, 8, tarOctal(0, 8));
  writeTarText(header, 124, 12, tarOctal(bodyLength, 12));
  writeTarText(header, 136, 12, tarOctal(0, 12));
  header.fill(0x20, 148, 156);
  writeTarText(header, 156, 1, entry.type);
  if (entry.linkName) {
    writeTarText(header, 157, 100, entry.linkName);
  }
  writeTarText(header, 257, 6, 'ustar\0');
  writeTarText(header, 263, 2, '00');
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function createTar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    blocks.push(tarHeader(entry), body);
    const padding = (512 - (body.byteLength % 512)) % 512;
    if (padding > 0) {
      blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

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

describe('canonicalizer tar compatibility', () => {
  it('canonicalizes legacy OldFile regular entries with their contents intact', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-canonicalizer-targz-oldfile-'));
    scratchPaths.push(scratchPath);
    const tarPath = join(scratchPath, 'legacy.tar');
    const inputPath = join(scratchPath, 'legacy.tar.gz');
    const outputPath = join(scratchPath, 'canonical.tar.gz');
    const extractedPath = join(scratchPath, 'extracted');
    const legacyContents = Buffer.from('legacy regular file contents');
    await writeFile(tarPath, createTar([{ name: 'legacy.txt', type: '\0', body: legacyContents }]));
    await runCommand('gzip', ['--stdout', '--', tarPath], { stdoutPath: inputPath });

    const regularFileType = tarTypes.name.get('0');
    tarTypes.name.set('0', 'OldFile');
    try {
      await canonicalizeArtifact({ inputPath, outputPath });
    } finally {
      if (regularFileType) {
        tarTypes.name.set('0', regularFileType);
      }
    }
    await mkdir(extractedPath);
    await runCommand('tar', [
      '--force-local',
      '--extract',
      '--file',
      outputPath,
      '--directory',
      extractedPath,
    ]);

    expect(await readFile(join(extractedPath, 'legacy.txt'))).toEqual(legacyContents);
    await expectNoCanonicalizerScratch(scratchPath);
    console.log('CANONICALIZER_OLDFILE_RESULT canonicalized=yes content-preserved=yes');
  });
});

describe('canonicalizer tar path safety', () => {
  it('rejects a symlink escape without writing outside the extraction root', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-canonicalizer-targz-traversal-'));
    scratchPaths.push(scratchPath);
    const tarPath = join(scratchPath, 'traversal.tar');
    const inputPath = join(scratchPath, 'traversal.tar.gz');
    const outputPath = join(scratchPath, 'canonical.tar.gz');
    const escapedPath = join(scratchPath, 'escaped-outside-extraction.txt');
    await writeFile(
      tarPath,
      createTar([
        { name: 'escape', type: '2', linkName: '..' },
        { name: 'safe.txt', type: '0', body: Buffer.from('safe') },
      ])
    );
    await runCommand('gzip', ['--stdout', '--', tarPath], { stdoutPath: inputPath });

    await expect(canonicalizeArtifact({ inputPath, outputPath })).rejects.toThrow(
      'unsafe tar entry'
    );
    expect(await pathExists(escapedPath)).toBeFalse();
    expect(await pathExists(outputPath)).toBeFalse();
    await expectNoCanonicalizerScratch(scratchPath);
  });

  it('rejects FIFO entries before extraction', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-canonicalizer-targz-fifo-'));
    scratchPaths.push(scratchPath);
    const tarPath = join(scratchPath, 'fifo.tar');
    const inputPath = join(scratchPath, 'fifo.tar.gz');
    const outputPath = join(scratchPath, 'canonical.tar.gz');
    await writeFile(tarPath, createTar([{ name: 'named-pipe', type: '6' }]));
    await runCommand('gzip', ['--stdout', '--', tarPath], { stdoutPath: inputPath });

    await expect(canonicalizeArtifact({ inputPath, outputPath })).rejects.toThrow(
      'unsupported tar entry type: FIFO'
    );
    expect(await pathExists(outputPath)).toBeFalse();
    await expectNoCanonicalizerScratch(scratchPath);
  });

  it('rejects a tar archive that exceeds the entry-count ceiling', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-canonicalizer-targz-entry-count-'));
    scratchPaths.push(scratchPath);
    const tarPath = join(scratchPath, 'too-many-entries.tar');
    const inputPath = join(scratchPath, 'too-many-entries.tar.gz');
    const outputPath = join(scratchPath, 'canonical.tar.gz');
    const entries: TarEntry[] = Array.from({ length: ARCHIVE_ENTRY_LIMIT }, (_, index) => ({
      name: `entry-${index.toString().padStart(6, '0')}`,
      type: '0',
    }));
    entries.push({ name: '../unsafe-after-limit', type: '0' });
    await writeFile(tarPath, createTar(entries));
    await runCommand('gzip', ['--stdout', '--', tarPath], { stdoutPath: inputPath });

    await expect(canonicalizeArtifact({ inputPath, outputPath })).rejects.toThrow(
      `tar.gz entry count exceeds ${ARCHIVE_ENTRY_LIMIT}`
    );
    expect(await pathExists(outputPath)).toBeFalse();
    await expectNoCanonicalizerScratch(scratchPath);
  }, 30_000);
});

describe('canonicalizer child environment', () => {
  it('does not pass the CAS secret to archive-tool child processes', async () => {
    const originalSecret = process.env.CAS_S3_SECRET_ACCESS_KEY;
    process.env.CAS_S3_SECRET_ACCESS_KEY = 'archive-child-must-not-receive-this';
    try {
      const childEnv = canonicalizerChildEnv();
      expect(childEnv.CAS_S3_SECRET_ACCESS_KEY).toBeUndefined();
      const { stdout } = await runCommand(
        process.execPath,
        ['-e', "process.stdout.write(process.env.CAS_S3_SECRET_ACCESS_KEY ?? 'secret-absent')"],
        { env: childEnv }
      );
      expect(stdout).toBe('secret-absent');
    } finally {
      if (originalSecret === undefined) {
        delete process.env.CAS_S3_SECRET_ACCESS_KEY;
      } else {
        process.env.CAS_S3_SECRET_ACCESS_KEY = originalSecret;
      }
    }
  });
});
