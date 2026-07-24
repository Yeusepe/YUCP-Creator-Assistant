import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveGnuArchiveTools, runCommand } from '../storage-core/process';

function deterministicBytes(seed: string, byteLength: number): Buffer {
  return createHash('shake256', { outputLength: byteLength }).update(seed).digest();
}

async function writeFixtureTree(
  rootPath: string,
  versionSeed: string,
  timestamp: Date,
  byteScale: number
): Promise<Map<string, string>> {
  const scaledBytes = (byteLength: number) => Math.max(1, Math.floor(byteLength * byteScale));
  const files = new Map<string, Buffer>([
    ['Assets/000-version.asset', deterministicBytes(versionSeed, scaledBytes(512 * 1024))],
    [
      'Assets/Audio/preview.ogg',
      deterministicBytes('shared-preview-ogg', scaledBytes(1536 * 1024)),
    ],
    [
      'Assets/Models/avatar.fbx',
      deterministicBytes('shared-avatar-fbx', scaledBytes(3 * 1024 * 1024)),
    ],
    [
      'Assets/Settings/package.asset',
      Buffer.from(
        'Material:\n  shader: Standard\n  renderQueue: 2000\n'.repeat(scaledBytes(12_000))
      ),
    ],
    [
      'Assets/Textures/albedo.png',
      deterministicBytes('shared-albedo-png', scaledBytes(3 * 1024 * 1024)),
    ],
  ]);
  const hashes = new Map<string, string>();

  for (const [relativePath, bytes] of files) {
    const filePath = join(rootPath, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
    await utimes(filePath, timestamp, timestamp);
    hashes.set(relativePath, createHash('sha256').update(bytes).digest('hex'));
  }
  for (const relativeDirectory of [
    'Assets/Audio',
    'Assets/Models',
    'Assets/Settings',
    'Assets/Textures',
    'Assets',
    '.',
  ]) {
    await utimes(join(rootPath, relativeDirectory), timestamp, timestamp);
  }
  return hashes;
}

export async function createUnityPackageFixture(input: {
  byteScale?: number;
  outputPath: string;
  timestamp: Date;
  treePath: string;
  versionSeed: string;
}): Promise<Map<string, string>> {
  const byteScale = input.byteScale ?? 1;
  if (!Number.isFinite(byteScale) || byteScale <= 0 || byteScale > 1) {
    throw new Error('Unitypackage fixture byteScale must be greater than zero and at most one');
  }
  await mkdir(input.treePath, { recursive: true });
  const hashes = await writeFixtureTree(
    input.treePath,
    input.versionSeed,
    input.timestamp,
    byteScale
  );
  const tarPath = `${input.outputPath}.tar`;
  const archiveTools = await resolveGnuArchiveTools();
  await runCommand(
    archiveTools.tarCommand,
    [
      '--force-local',
      '--create',
      '--file',
      tarPath,
      '--format=gnu',
      '--sort=name',
      '--directory',
      input.treePath,
      '.',
    ],
    { env: archiveTools.env }
  );
  try {
    await utimes(tarPath, input.timestamp, input.timestamp);
    await runCommand(archiveTools.gzipCommand, ['--stdout', '--', tarPath], {
      env: archiveTools.env,
      stdoutPath: input.outputPath,
    });
  } finally {
    await rm(tarPath, { force: true });
  }
  return hashes;
}

export async function createUnityPackageRecordFixture(input: {
  outputPath: string;
  timestamp: Date;
  versionSeed: string;
}): Promise<Map<string, string>> {
  const files = new Map<string, Buffer>([
    ['Assets/000-version.asset', deterministicBytes(input.versionSeed, 512 * 1024)],
    ['Assets/Audio/preview.ogg', deterministicBytes('shared-preview-ogg', 1536 * 1024)],
    ['Assets/Models/avatar.fbx', deterministicBytes('shared-avatar-fbx', 3 * 1024 * 1024)],
    [
      'Assets/Settings/package.asset',
      Buffer.from('Material:\n  shader: Standard\n  renderQueue: 2000\n'.repeat(12_000)),
    ],
    ['Assets/Textures/albedo.png', deterministicBytes('shared-albedo-png', 3 * 1024 * 1024)],
  ]);
  const scratch = await mkdtemp(join(tmpdir(), 'yucp-unitypackage-record-fixture-'));
  const recordsRoot = join(scratch, 'records');
  const hashes = new Map<string, string>();
  const archiveTools = await resolveGnuArchiveTools();
  const tarPath = `${input.outputPath}.tar`;
  try {
    for (const [logicalPath, bytes] of files) {
      const guid = createHash('sha256').update(logicalPath).digest('hex').slice(0, 32);
      const recordRoot = join(recordsRoot, guid);
      const meta = Buffer.from(
        `fileFormatVersion: 2\nguid: ${guid}\nDefaultImporter:\n  externalObjects: {}\n`
      );
      await mkdir(recordRoot, { recursive: true });
      await writeFile(join(recordRoot, 'pathname'), logicalPath, 'utf8');
      await writeFile(join(recordRoot, 'asset'), bytes);
      await writeFile(join(recordRoot, 'asset.meta'), meta);
      hashes.set(logicalPath, createHash('sha256').update(bytes).digest('hex'));
      hashes.set(`${logicalPath}.meta`, createHash('sha256').update(meta).digest('hex'));
    }
    await runCommand(
      archiveTools.tarCommand,
      [
        '--force-local',
        '--create',
        '--file',
        tarPath,
        '--format=gnu',
        '--sort=name',
        '--directory',
        recordsRoot,
        '.',
      ],
      { env: archiveTools.env }
    );
    await utimes(tarPath, input.timestamp, input.timestamp);
    await runCommand(archiveTools.gzipCommand, ['--stdout', '--', tarPath], {
      env: archiveTools.env,
      stdoutPath: input.outputPath,
    });
    return hashes;
  } finally {
    await rm(tarPath, { force: true });
    await rm(scratch, { force: true, recursive: true });
  }
}
