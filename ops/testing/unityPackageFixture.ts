import { createHash } from 'node:crypto';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runCommand } from '../storage-core/process';

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
  await runCommand('tar', [
    '--force-local',
    '--create',
    '--file',
    tarPath,
    '--format=gnu',
    '--sort=name',
    '--directory',
    input.treePath,
    '.',
  ]);
  try {
    await utimes(tarPath, input.timestamp, input.timestamp);
    await runCommand('gzip', ['--stdout', '--', tarPath], { stdoutPath: input.outputPath });
  } finally {
    await rm(tarPath, { force: true });
  }
  return hashes;
}
